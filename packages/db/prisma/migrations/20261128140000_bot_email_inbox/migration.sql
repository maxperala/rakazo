-- Additive: the previous release never reads this table.
CREATE TABLE "bot_email_messages" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "messageId" TEXT,
    "references" TEXT[],
    "fromAddress" TEXT NOT NULL,
    "fromName" TEXT NOT NULL,
    "verified" BOOLEAN NOT NULL,
    "to" TEXT[],
    "cc" TEXT[],
    "subject" TEXT NOT NULL,
    "sentAt" TEXT,
    "text" TEXT NOT NULL,
    "attachments" JSONB NOT NULL DEFAULT '[]',
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bot_email_messages_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "bot_email_messages_botId_key_key" ON "bot_email_messages"("botId", "key");

CREATE INDEX "bot_email_messages_botId_receivedAt_idx" ON "bot_email_messages"("botId", "receivedAt");

ALTER TABLE "bot_email_messages" ADD CONSTRAINT "bot_email_messages_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "bot_email_messages" ADD CONSTRAINT "bot_email_messages_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Same policies as scratchpad_items (20261022120000_row_level_security_tenant_tables).
ALTER TABLE "bot_email_messages" ENABLE ROW LEVEL SECURITY;
CREATE POLICY bot_email_messages_tenant ON "bot_email_messages"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY bot_email_messages_system ON "bot_email_messages"
  USING (current_setting('app.rls_bypass', true) = 'on');
