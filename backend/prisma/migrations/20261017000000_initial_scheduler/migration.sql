CREATE TABLE `Sender` (
    `id` VARCHAR(64) NOT NULL,
    `email` VARCHAR(320) NOT NULL,
    `name` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `Email` (
    `id` VARCHAR(191) NOT NULL,
    `idempotencyKey` VARCHAR(191) NOT NULL,
    `senderId` VARCHAR(64) NOT NULL,
    `recipient` VARCHAR(320) NOT NULL,
    `subject` VARCHAR(998) NOT NULL,
    `body` LONGTEXT NOT NULL,
    `scheduledAt` DATETIME(3) NOT NULL,
    `status` ENUM('SCHEDULED', 'PROCESSING', 'SENT', 'FAILED') NOT NULL DEFAULT 'SCHEDULED',
    `bullmqJobId` VARCHAR(191) NULL,
    `attemptCount` INTEGER NOT NULL DEFAULT 0,
    `lastError` TEXT NULL,
    `smtpAcceptedAt` DATETIME(3) NULL,
    `smtpMessageId` VARCHAR(998) NULL,
    `processingStartedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    UNIQUE INDEX `Email_idempotencyKey_key` (`idempotencyKey`),
    UNIQUE INDEX `Email_bullmqJobId_key` (`bullmqJobId`),
    INDEX `Email_status_scheduledAt_idx` (`status`, `scheduledAt`),
    INDEX `Email_senderId_createdAt_idx` (`senderId`, `createdAt`),
    PRIMARY KEY (`id`),
    CONSTRAINT `Email_senderId_fkey` FOREIGN KEY (`senderId`) REFERENCES `Sender` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `EmailOutbox` (
    `id` VARCHAR(191) NOT NULL,
    `emailId` VARCHAR(191) NOT NULL,
    `status` ENUM('PENDING', 'ENQUEUED') NOT NULL DEFAULT 'PENDING',
    `attemptCount` INTEGER NOT NULL DEFAULT 0,
    `lastError` TEXT NULL,
    `enqueuedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    UNIQUE INDEX `EmailOutbox_emailId_key` (`emailId`),
    INDEX `EmailOutbox_status_createdAt_idx` (`status`, `createdAt`),
    PRIMARY KEY (`id`),
    CONSTRAINT `EmailOutbox_emailId_fkey` FOREIGN KEY (`emailId`) REFERENCES `Email` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
