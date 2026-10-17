CREATE TABLE `SlackConnection` (
    `deploymentKey` VARCHAR(64) NOT NULL DEFAULT 'default',
    `workspaceId` VARCHAR(64) NOT NULL,
    `workspaceName` VARCHAR(191) NOT NULL,
    `channelId` VARCHAR(64) NOT NULL,
    `channelName` VARCHAR(191) NOT NULL,
    `webhookCiphertext` LONGTEXT NOT NULL,
    `webhookNonce` VARCHAR(32) NOT NULL,
    `webhookAuthTag` VARCHAR(32) NOT NULL,
    `status` ENUM('ACTIVE', 'REVOKED') NOT NULL DEFAULT 'ACTIVE',
    `installedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    UNIQUE INDEX `SlackConnection_workspaceId_key` (`workspaceId`),
    PRIMARY KEY (`deploymentKey`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `SlackNotificationOutbox` (
    `id` VARCHAR(191) NOT NULL,
    `eventKey` CHAR(64) NOT NULL,
    `senderId` VARCHAR(64) NOT NULL,
    `senderEmail` VARCHAR(320) NOT NULL,
    `senderName` VARCHAR(191) NULL,
    `hourlyLimit` INTEGER UNSIGNED NOT NULL,
    `nextEligibleAt` DATETIME(3) NULL,
    `status` ENUM('PENDING', 'DELIVERED', 'FAILED', 'SKIPPED') NOT NULL DEFAULT 'PENDING',
    `attemptCount` INTEGER NOT NULL DEFAULT 0,
    `lastError` TEXT NULL,
    `deliveredAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    UNIQUE INDEX `SlackNotificationOutbox_eventKey_key` (`eventKey`),
    INDEX `SlackNotificationOutbox_status_createdAt_idx` (`status`, `createdAt`),
    INDEX `SlackNotificationOutbox_senderId_createdAt_idx` (`senderId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
