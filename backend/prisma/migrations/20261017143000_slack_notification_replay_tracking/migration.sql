ALTER TABLE `SlackNotificationOutbox`
    ADD COLUMN `replayCount` INTEGER NOT NULL DEFAULT 0;
