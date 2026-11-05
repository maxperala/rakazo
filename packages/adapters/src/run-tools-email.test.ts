import {
  toolRequiresApproval,
  toolRequiresExplicitApproval,
  toolResultTaintsRun,
  unattendedTriggerToolRequiresApproval,
} from "@rakazo/core";
import { describe, expect, it, vi } from "vitest";
import { selectBuiltinToolsForRun } from "./run-tool-selection.js";
import { emailTools, SEND_EMAIL_DAILY_LIMIT } from "./run-tools-email.js";

type Row = {
  id: string;
  botId: string;
  fromAddress: string;
  fromName: string;
  verified: boolean;
  to: string[];
  cc: string[];
  subject: string;
  sentAt: string | null;
  text: string;
  attachments: unknown[];
  receivedAt: Date;
};

function row(overrides: Partial<Row>): Row {
  return {
    id: "email-1",
    botId: "bot-1",
    fromAddress: "noreply@shop.test",
    fromName: "Shop",
    verified: false,
    to: ["scout@bots.test"],
    cc: [],
    subject: "Your code",
    sentAt: null,
    text: "Your sign-in code is 123456.",
    attachments: [],
    receivedAt: new Date("2026-11-05T10:00:00.000Z"),
    ...overrides,
  };
}

function fakeRun(rows: Row[], options: { runUserId?: string; arriving?: Row } = {}) {
  const inbox = [...rows];
  let listed = 0;
  const copyEarlierFiles = vi.fn();
  const matches = (email: Row, where: Record<string, unknown>) => {
    const since = (where.receivedAt as { gt: Date } | undefined)?.gt;
    const query = (where.OR as Array<Record<string, { contains: string }>> | undefined)?.[0];
    const words = query ? Object.values(query)[0]?.contains.toLowerCase() : undefined;
    return (
      email.botId === where.botId &&
      (!since || email.receivedAt > since) &&
      (!words ||
        [email.fromAddress, email.fromName, email.subject, email.text].some((field) =>
          field.toLowerCase().includes(words),
        ))
    );
  };
  const ctx = {
    deps: {
      prisma: {
        botEmailMessage: {
          findFirst: async ({ where }: { where: { id: string; botId: string } }) =>
            inbox.find((email) => email.id === where.id && email.botId === where.botId) ?? null,
          findMany: async ({ where }: { where: Record<string, unknown> }) => {
            listed += 1;
            // Mail that arrives while the bot waits shows up on the second look.
            if (listed === 2 && options.arriving) inbox.push(options.arriving);
            return inbox
              .filter((email) => matches(email, where))
              .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime());
          },
        },
      },
    },
    bot: { id: "bot-1", userId: "owner-1" },
    run: { userId: options.runUserId ?? "owner-1" },
    computer: { copyEarlierFiles },
    context: { signal: new AbortController().signal },
  };
  const call = (args: Record<string, unknown>) =>
    emailTools.read_email!(
      ctx as never,
      {
        name: "read_email",
        args,
        executionId: "call-1",
        finish: async (result: unknown) => result,
      } as never,
    ) as Promise<Record<string, unknown>>;
  return { call, copyEarlierFiles };
}

describe("read_email", () => {
  it("lists the newest mail as untrusted data", async () => {
    const { call } = fakeRun([
      row({ id: "old", receivedAt: new Date("2026-11-01T00:00:00.000Z"), subject: "Old" }),
      row({ id: "new", text: `Code 999.\n\n${"x".repeat(500)}` }),
      row({ id: "elsewhere", botId: "bot-2" }),
    ]);

    const result = await call({});

    expect(result.untrusted).toBe(true);
    expect(result.now).toEqual(expect.any(String));
    expect(result.emails).toEqual([
      expect.objectContaining({ id: "new", from: "Shop <noreply@shop.test>", verified: false }),
      expect.objectContaining({ id: "old", subject: "Old" }),
    ]);
    const preview = (result.emails as Array<{ preview: string }>)[0]?.preview ?? "";
    expect(preview.startsWith("Code 999. xxx")).toBe(true);
    expect(preview.length).toBeLessThanOrEqual(160);
  });

  it("finds mail by words in it and by when it arrived", async () => {
    const { call } = fakeRun([
      row({ id: "receipt", subject: "Receipt #42", receivedAt: new Date("2026-11-04") }),
      row({ id: "code", subject: "Your code", receivedAt: new Date("2026-11-05") }),
    ]);

    expect(((await call({ query: "receipt" })).emails as unknown[]).length).toBe(1);
    expect(
      ((await call({ since: "2026-11-04T12:00:00.000Z" })).emails as Array<{ id: string }>).map(
        (email) => email.id,
      ),
    ).toEqual(["code"]);
  });

  it("waits for a matching email to arrive", async () => {
    const { call } = fakeRun([], { arriving: row({ id: "late", receivedAt: new Date() }) });

    const result = await call({ query: "code", waitSeconds: 10 });

    expect(result.emails).toEqual([expect.objectContaining({ id: "late" })]);
  });

  it("waits a wait shorter than one poll", async () => {
    const { call } = fakeRun([], { arriving: row({ id: "late", receivedAt: new Date() }) });

    const result = await call({ waitSeconds: 1 });

    expect(result.emails).toEqual([expect.objectContaining({ id: "late" })]);
  });

  it("reads one email whole, a page at a time, and copies its files", async () => {
    const { call, copyEarlierFiles } = fakeRun([
      row({
        text: "a".repeat(10_000),
        attachments: [
          { artifactId: "art-1", name: "invoice.pdf", mimeType: "application/pdf", size: 3 },
          { name: "setup.exe" },
        ],
      }),
    ]);

    const first = (await call({ id: "email-1" })).email as Record<string, unknown>;
    const rest = (await call({ id: "email-1", textOffset: first.nextTextOffset })).email as Record<
      string,
      unknown
    >;

    expect(first).toMatchObject({
      from: "Shop <noreply@shop.test>",
      verified: false,
      nextTextOffset: 8_000,
      files: [
        { name: "invoice.pdf", path: "attachments/art-1.pdf" },
        { name: "setup.exe", unavailable: true },
      ],
    });
    expect(String(first.text)).toHaveLength(8_000);
    expect(String(rest.text)).toHaveLength(2_000);
    expect(rest.nextTextOffset).toBeUndefined();
    expect(copyEarlierFiles).toHaveBeenCalledWith([
      expect.objectContaining({ kind: "file", artifactId: "art-1", name: "invoice.pdf" }),
    ]);
  });

  it("reads only this bot's mail, and only in its owner's runs", async () => {
    const mine = fakeRun([row({ id: "theirs", botId: "bot-2" })]);
    const visitor = fakeRun([row({})], { runUserId: "visitor-1" });

    expect(await mine.call({ id: "theirs" })).toEqual({
      error: "No email with that id in your inbox.",
    });
    expect(await visitor.call({})).toEqual({ error: "Only the bot's owner can do that." });
  });

  it("is offered only where the inbox may be read, and needs no approval to read", () => {
    const names = (emailInbox: boolean) =>
      selectBuiltinToolsForRun({
        graphicalToolsAllowed: false,
        groupId: null,
        trigger: "webhook",
        semanticMemoryEnabled: false,
        messagingChannelRun: false,
        emailInbox,
      }).map((tool) => tool.name);

    expect(names(true)).toContain("read_email");
    expect(names(false)).not.toContain("read_email");
    expect(unattendedTriggerToolRequiresApproval("webhook", "read_email", false)).toBe(false);
    // What it returns is someone else's mail, so the run counts as having read outside content.
    expect(toolResultTaintsRun("read_email")).toBe(true);
  });
});

describe("claim_email_address", () => {
  function claimRun(
    options: {
      claimed?: Record<string, string>;
      domain?: string;
      runUserId?: string;
      raceTo?: string;
      tainted?: boolean;
      approved?: boolean;
    } = {},
  ) {
    // localPart → botId, as bot_email_addresses keeps them.
    const names = new Map(Object.entries(options.claimed ?? {}));
    const ctx = {
      deps: {
        inboundEmailDomain: "domain" in options ? options.domain : "bots.test",
        prisma: {
          // This is the run's first attempt.
          attempt: { count: async () => 1 },
          botEmailAddress: {
            findUnique: async ({ where }: { where: { botId?: string; localPart?: string } }) => {
              if (where.localPart) {
                const botId = names.get(where.localPart);
                return botId ? { botId, localPart: where.localPart } : null;
              }
              const entry = [...names].find(([, botId]) => botId === where.botId);
              return entry ? { localPart: entry[0], botId: entry[1] } : null;
            },
            create: async ({ data }: { data: { localPart: string; botId: string } }) => {
              if (options.raceTo) names.set(options.raceTo, data.botId);
              if (options.raceTo || names.has(data.localPart))
                throw Object.assign(new Error("taken"), { code: "P2002" });
              names.set(data.localPart, data.botId);
              return data;
            },
          },
        },
      },
      bot: { id: "bot-1", userId: "owner-1" },
      run: { userId: options.runUserId ?? "owner-1" },
      state: { tainted: Boolean(options.tainted) },
      runId: "run-1",
      trust: { receivedOutsideMessage: async () => false },
    };
    const call = (args: Record<string, unknown>) =>
      emailTools.claim_email_address!(
        ctx as never,
        {
          name: "claim_email_address",
          args,
          executionId: "c",
          nextApprovedTool: options.approved ? "claim_email_address" : undefined,
          finish: async (r: unknown) => r,
        } as never,
      ) as Promise<Record<string, unknown>>;
    return { call, names };
  }

  it("claims the name the owner agreed to, for good", async () => {
    const { call, names } = claimRun();

    expect(await call({ name: " Scout " })).toEqual({ address: "scout@bots.test" });
    expect(names.get("scout")).toBe("bot-1");
    expect(await call({ name: "other" })).toEqual({
      error: "You already have an address, and it can't change.",
      address: "scout@bots.test",
    });
  });

  it("claims after outside content only when the owner approved this call", async () => {
    const steered = claimRun({ tainted: true });
    const approved = claimRun({ tainted: true, approved: true });

    expect((await steered.call({ name: "scout" })).error).toContain("read outside content");
    expect(steered.names.size).toBe(0);
    expect(await approved.call({ name: "scout" })).toEqual({ address: "scout@bots.test" });
  });

  it("tells a claim that lost a race to another name what the bot got", async () => {
    // Another claim for this bot, with another name, lands first.
    const { call } = claimRun({ raceTo: "raced" });

    expect(await call({ name: "scout" })).toEqual({
      error: "You already have an address, and it can't change.",
      address: "raced@bots.test",
    });
  });

  it("refuses taken, reserved and malformed names, and anyone but the owner", async () => {
    const { call } = claimRun({ claimed: { scout: "bot-2" } });

    expect(await call({ name: "scout" })).toEqual({
      error: "That address isn't available. Ask for another.",
    });
    expect((await call({ name: "postmaster" })).error).toBe("That address isn't available");
    expect((await call({ name: "a" })).error).toEqual(expect.any(String));
    expect(await claimRun({ runUserId: "visitor-1" }).call({ name: "x1" })).toEqual({
      error: "Only the bot's owner can do that.",
    });
    expect(await claimRun({ domain: undefined }).call({ name: "x1" })).toEqual({
      error: "This server doesn't receive email.",
    });
  });

  it("is offered only to the owner's own chat before the bot has an address, and always asks", () => {
    const names = (options: { trigger: string; groupId?: string; emailClaimable: boolean }) =>
      selectBuiltinToolsForRun({
        graphicalToolsAllowed: false,
        groupId: options.groupId ?? null,
        trigger: options.trigger,
        semanticMemoryEnabled: false,
        messagingChannelRun: false,
        emailClaimable: options.emailClaimable,
      }).map((tool) => tool.name);

    expect(names({ trigger: "user", emailClaimable: true })).toContain("claim_email_address");
    expect(names({ trigger: "user", emailClaimable: false })).not.toContain("claim_email_address");
    expect(names({ trigger: "webhook", emailClaimable: true })).not.toContain(
      "claim_email_address",
    );
    expect(names({ trigger: "user", groupId: "g", emailClaimable: true })).not.toContain(
      "claim_email_address",
    );
    expect(toolRequiresExplicitApproval("claim_email_address")).toBe(true);
  });
});

describe("send_email", () => {
  type Saved = Record<string, unknown> & {
    id: string;
    key: string;
    sent: boolean;
    receivedAt: Date;
  };

  function sendRun(
    options: { sentToday?: number; fail?: boolean; original?: Record<string, unknown> } = {},
  ) {
    const saved: Saved[] = [];
    const send = vi.fn(async (_message: Record<string, unknown>) => {
      if (options.fail) throw new Error("domain not verified");
    });
    const ctx = {
      deps: {
        inboundEmailDomain: "bots.test",
        email: { send },
        prisma: {
          botEmailAddress: { findUnique: async () => ({ localPart: "scout" }) },
          botEmailMessage: {
            findFirst: async ({ where }: { where: { id: string } }) =>
              where.id === "in-1" ? (options.original ?? null) : null,
            findUnique: async ({ where }: { where: { botId_key: { key: string } } }) =>
              saved.find((row) => row.key === where.botId_key.key) ?? null,
            count: async () => options.sentToday ?? saved.length,
            create: async ({ data }: { data: Record<string, unknown> }) => {
              const row = {
                ...data,
                id: `sent-${saved.length + 1}`,
                receivedAt: new Date(),
              } as Saved;
              saved.push(row);
              return { id: row.id };
            },
            delete: async ({ where }: { where: { id: string } }) => {
              saved.splice(
                saved.findIndex((row) => row.id === where.id),
                1,
              );
            },
          },
        },
      },
      bot: { id: "bot-1", userId: "owner-1", spaceId: "space-1", name: 'Scout "Bot"' },
      run: { userId: "owner-1" },
      secrets: ["hunter2-secret", "line-one\nline-two"],
    };
    const call = (args: Record<string, unknown>, effectKey = "effect-1") =>
      emailTools.send_email!(
        ctx as never,
        {
          name: "send_email",
          args,
          effectKey,
          executionId: "c",
          finish: async (r: unknown) => r,
        } as never,
      ) as Promise<Record<string, unknown>>;
    return { call, send, saved };
  }

  it("sends from the bot's own address and keeps a copy in its inbox", async () => {
    const { call, send, saved } = sendRun();

    const result = await call({
      to: "Support@Shop.test",
      subject: "Order 42",
      text: "My password is hunter2-secret. Where is order 42?",
    });

    expect(result).toEqual({
      sent: true,
      id: "sent-1",
      from: "scout@bots.test",
      to: ["support@shop.test"],
    });
    expect(send).toHaveBeenCalledWith({
      from: '"Scout Bot" <scout@bots.test>',
      replyTo: "scout@bots.test",
      to: ["support@shop.test"],
      subject: "Order 42",
      text: expect.not.stringContaining("hunter2-secret"),
    });
    expect(saved).toEqual([
      expect.objectContaining({ sent: true, fromAddress: "scout@bots.test", key: "sent:effect-1" }),
    ]);
  });

  it("keeps a reply's subject within the limit", async () => {
    const { call, send } = sendRun({
      original: { subject: "s".repeat(500), messageId: "<t@shop.test>", references: [] },
    });

    await call({ to: ["a@shop.test"], text: "Hi", inReplyTo: "in-1" });

    expect(String(send.mock.calls[0]?.[0].subject)).toHaveLength(500);
  });

  it("keeps a secret that spans lines out of the subject", async () => {
    const { call, send } = sendRun();

    await call({ to: ["a@shop.test"], subject: "Key line-one\nline-two", text: "Hi" });

    expect(send.mock.calls[0]?.[0].subject).not.toContain("line-one");
  });

  it("answers an email in its own thread", async () => {
    const { call, send } = sendRun({
      original: {
        subject: "Your ticket",
        messageId: "<t-2@shop.test>",
        references: ["<t-1@shop.test>"],
      },
    });

    await call({ to: ["support@shop.test"], text: "Thanks!", inReplyTo: "in-1" });

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: "Re: Your ticket",
        headers: {
          "In-Reply-To": "<t-2@shop.test>",
          References: "<t-1@shop.test> <t-2@shop.test>",
        },
      }),
    );
  });

  it("never sends an interrupted call again, and frees the slot of one that failed", async () => {
    const retried = sendRun();
    await retried.call({ to: ["a@shop.test"], subject: "Hi", text: "Hello" });
    // Only an attempt that never finished reaches the tool again; the gate replays the rest.
    expect(
      (await retried.call({ to: ["a@shop.test"], subject: "Hi", text: "Hello" })).error,
    ).toContain("may or may not have gone out");
    expect(retried.send).toHaveBeenCalledTimes(1);

    const failing = sendRun({ fail: true });
    expect(await failing.call({ to: ["a@shop.test"], subject: "Hi", text: "Hello" })).toEqual({
      error: "Sending failed (domain not verified). It most likely did not go out.",
    });
    expect(failing.saved).toEqual([]);
  });

  it("keeps a follow-up to the bot's own email in that thread", async () => {
    const { call, send } = sendRun({
      original: {
        subject: "Re: Your ticket",
        messageId: null,
        references: ["<t-1@shop.test>", "<t-2@shop.test>"],
      },
    });

    await call({ to: ["support@shop.test"], text: "Any news?", inReplyTo: "in-1" });

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: "Re: Your ticket",
        headers: {
          "In-Reply-To": "<t-2@shop.test>",
          References: "<t-1@shop.test> <t-2@shop.test>",
        },
      }),
    );
  });

  it("refuses past the daily limit, too many people, or no subject", async () => {
    const { call, send } = sendRun({ sentToday: SEND_EMAIL_DAILY_LIMIT });
    const many = Array.from({ length: 11 }, (_, index) => `p${index}@shop.test`);

    expect((await call({ to: ["a@shop.test"], subject: "Hi", text: "x" })).error).toContain(
      "Try again tomorrow",
    );
    expect(await sendRun().call({ to: many, subject: "Hi", text: "x" })).toEqual({
      error: "Send to at most 10 people at once.",
    });
    expect(await sendRun().call({ to: ["a@shop.test"], text: "x" })).toEqual({
      error: "Give the email a subject.",
    });
    expect((await sendRun().call({ to: [], subject: "Hi", text: "x" })).error).toContain(
      "Name at least one recipient.",
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("is offered only where the inbox is read and email can go out, under the usual approvals", () => {
    const names = (emailSend: boolean) =>
      selectBuiltinToolsForRun({
        graphicalToolsAllowed: false,
        groupId: null,
        trigger: "user",
        semanticMemoryEnabled: false,
        messagingChannelRun: false,
        emailInbox: true,
        emailSend,
      }).map((tool) => tool.name);

    expect(names(true)).toContain("send_email");
    expect(names(false)).not.toContain("send_email");
    expect(toolRequiresApproval("send_email", false)).toBe(true);
    expect(toolRequiresExplicitApproval("send_email")).toBe(false);
    expect(unattendedTriggerToolRequiresApproval("webhook", "send_email", false)).toBe(true);
    expect(toolResultTaintsRun("send_email")).toBe(false);
  });
});
