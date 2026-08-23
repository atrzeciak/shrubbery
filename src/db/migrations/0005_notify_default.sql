-- Event reminders became opt-out: switch the accounts that predate the change on.
UPDATE accounts SET notify_events = 1 WHERE notify_events = 0;
