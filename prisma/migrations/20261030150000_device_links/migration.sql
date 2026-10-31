-- CreateTable
CREATE TABLE "device_links" (
    "id" TEXT NOT NULL,
    "ephemeralPub" TEXT NOT NULL,
    "mac" TEXT NOT NULL,
    "userId" TEXT,
    "sealedBundle" TEXT,
    "bundleMac" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "device_links_expiresAt_idx" ON "device_links"("expiresAt");

-- AddForeignKey
ALTER TABLE "device_links" ADD CONSTRAINT "device_links_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
