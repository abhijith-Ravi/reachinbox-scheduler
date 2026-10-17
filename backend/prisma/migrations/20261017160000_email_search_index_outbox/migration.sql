ALTER TABLE `Email`
    ADD COLUMN `searchVersion` BIGINT UNSIGNED NOT NULL DEFAULT 1;

CREATE TABLE `EmailSearchOutbox` (
    `id` VARCHAR(191) NOT NULL,
    `emailId` VARCHAR(191) NOT NULL,
    `version` BIGINT UNSIGNED NOT NULL,
    `status` ENUM('PENDING', 'PROCESSING', 'INDEXED') NOT NULL DEFAULT 'PENDING',
    `attemptCount` INTEGER NOT NULL DEFAULT 0,
    `nextAttemptAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `leaseExpiresAt` DATETIME(3) NULL,
    `lastError` VARCHAR(500) NULL,
    `indexedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    UNIQUE INDEX `EmailSearchOutbox_emailId_version_key` (`emailId`, `version`),
    INDEX `EmailSearchOutbox_status_nextAttemptAt_idx` (`status`, `nextAttemptAt`),
    INDEX `EmailSearchOutbox_status_leaseExpiresAt_idx` (`status`, `leaseExpiresAt`),
    PRIMARY KEY (`id`),
    CONSTRAINT `EmailSearchOutbox_emailId_fkey` FOREIGN KEY (`emailId`) REFERENCES `Email` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT INTO `EmailSearchOutbox` (`id`, `emailId`, `version`, `status`, `attemptCount`, `nextAttemptAt`, `createdAt`, `updatedAt`)
SELECT UUID(), `id`, `searchVersion`, 'PENDING', 0, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)
FROM `Email`;
