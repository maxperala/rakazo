-- Additive: the previous release reads this table without the column, which defaults to false.
ALTER TABLE "bot_email_messages" ADD COLUMN "sent" BOOLEAN NOT NULL DEFAULT false;
