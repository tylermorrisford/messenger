-- Rebuild "messages" as a table partitioned by month on "createdAt", so a month of expired messages goes
-- with one DROP TABLE instead of a row-by-row DELETE. Postgres needs the partition key in every unique
-- constraint, so the primary key becomes ("id", "createdAt") and the unique index on "seq" gains "createdAt".

-- Move the old table out of the way; its index names would collide with the new table's
ALTER TABLE "messages" RENAME TO "messages_old";
ALTER INDEX "messages_pkey" RENAME TO "messages_old_pkey";
ALTER INDEX "messages_seq_key" RENAME TO "messages_old_seq_key";
ALTER INDEX "messages_conversationId_seq_idx" RENAME TO "messages_old_conversationId_seq_idx";
ALTER INDEX "messages_expiresAt_idx" RENAME TO "messages_old_expiresAt_idx";

-- CreateTable
CREATE TABLE "messages" (
    "id" TEXT NOT NULL,
    "seq" BIGINT NOT NULL DEFAULT nextval('"messages_seq_seq"'),
    "conversationId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "senderKeyVersion" INTEGER NOT NULL,
    "epoch" INTEGER NOT NULL,
    "ttlSeconds" INTEGER,
    "nonce" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id", "createdAt")
) PARTITION BY RANGE ("createdAt");

-- Keep the existing sequence and its position: seq is the cursor clients page with
ALTER SEQUENCE "messages_seq_seq" OWNED BY "messages"."seq";

-- CreateIndex
CREATE UNIQUE INDEX "messages_seq_createdAt_key" ON "messages"("seq", "createdAt");

-- CreateIndex
CREATE INDEX "messages_conversationId_seq_idx" ON "messages"("conversationId", "seq");

-- CreateIndex
CREATE INDEX "messages_expiresAt_idx" ON "messages"("expiresAt");

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One partition per month from the oldest existing message through next month. From here on the API
-- creates the next month's partition when it starts and the sweep does the same every run.
DO $$
DECLARE
  month_start date := date_trunc('month', coalesce((SELECT min("createdAt") FROM "messages_old"), now() AT TIME ZONE 'UTC'))::date;
  final_month date := (date_trunc('month', now() AT TIME ZONE 'UTC') + interval '1 month')::date;
BEGIN
  WHILE month_start <= final_month LOOP
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF "messages" FOR VALUES FROM (%L) TO (%L)',
      'messages_' || to_char(month_start, 'YYYY_MM'),
      month_start,
      month_start + interval '1 month'
    );
    month_start := (month_start + interval '1 month')::date;
  END LOOP;
END $$;

INSERT INTO "messages" ("id", "seq", "conversationId", "senderId", "senderKeyVersion", "epoch", "ttlSeconds", "nonce", "ciphertext", "signature", "createdAt", "expiresAt")
SELECT "id", "seq", "conversationId", "senderId", "senderKeyVersion", "epoch", "ttlSeconds", "nonce", "ciphertext", "signature", "createdAt", "expiresAt"
FROM "messages_old";

DROP TABLE "messages_old";
