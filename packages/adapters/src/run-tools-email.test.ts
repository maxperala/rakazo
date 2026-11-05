import {
  toolRequiresExplicitApproval,
  toolResultTaintsRun,
  unattendedTriggerToolRequiresApproval,
} from "@rakazo/core";
import { describe, expect, it, vi } from "vitest";
import { selectBuiltinToolsForRun } from "./run-tool-selection.js";
import { emailTools } from "./run-tools-email.js";

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
