-- A person with an account has one address, the one they log in with. From here on every link
-- writes it into people.email; this catches up the rows linked before that rule existed.
UPDATE people SET email = (SELECT a.email FROM accounts a WHERE a.person_id = people.id)
WHERE EXISTS (SELECT 1 FROM accounts a WHERE a.person_id = people.id);
