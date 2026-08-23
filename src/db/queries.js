import { MEDIA_CAP } from "../media/rules.js";
// accounts
export const insertAccount = (db, a) =>
  db.prepare("INSERT INTO accounts (id, email, role, lang, created_at, invited_by, person_id, notify_events) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(a.id, a.email, a.role, a.lang, a.createdAt, a.invitedBy, a.personId ?? null, a.notifyEvents ?? 1);
export const accountByEmail = (db, email) => db.prepare("SELECT * FROM accounts WHERE email = ?").bind(email);
export const accountById = (db, id) => db.prepare("SELECT * FROM accounts WHERE id = ?").bind(id);
export const listAccounts = (db) =>
  db.prepare(`SELECT a.id, a.email, a.role, a.lang, a.created_at, a.disabled_at, a.person_id, a.founder, a.protected,
                (SELECT COUNT(*) FROM passkeys p WHERE p.account_id = a.id) AS passkeys,
                (SELECT MAX(last_seen_at) FROM sessions s WHERE s.account_id = a.id AND s.revoked_at IS NULL) AS last_seen_at
              FROM accounts a ORDER BY a.created_at`);
export const setRole = (db, id, role) => db.prepare("UPDATE accounts SET role = ? WHERE id = ?").bind(role, id);
export const setProtected = (db, id, v) => db.prepare("UPDATE accounts SET protected = ? WHERE id = ?").bind(v, id);
export const setLang = (db, id, lang) => db.prepare("UPDATE accounts SET lang = ? WHERE id = ?").bind(lang, id);
export const disableAccount = (db, id, at) => db.prepare("UPDATE accounts SET disabled_at = ? WHERE id = ?").bind(at, id);
export const enableAccount = (db, id) => db.prepare("UPDATE accounts SET disabled_at = NULL WHERE id = ?").bind(id);

// passkeys
export const insertPasskey = (db, p) =>
  db.prepare("INSERT INTO passkeys (id, account_id, credential_id, public_key, counter, transports, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(p.id, p.accountId, p.credentialId, p.publicKey, p.counter, p.transports, p.name, p.createdAt);
export const passkeysByAccount = (db, accountId) =>
  db.prepare("SELECT id, credential_id, transports, name, created_at, last_used_at FROM passkeys WHERE account_id = ? ORDER BY created_at").bind(accountId);
export const passkeyByCredentialId = (db, credentialId) => db.prepare("SELECT * FROM passkeys WHERE credential_id = ?").bind(credentialId);
export const countPasskeys = (db, accountId) => db.prepare("SELECT COUNT(*) AS n FROM passkeys WHERE account_id = ?").bind(accountId);
export const updatePasskeyCounter = (db, id, counter, at) => db.prepare("UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?").bind(counter, at, id);
export const renamePasskey = (db, id, accountId, name) => db.prepare("UPDATE passkeys SET name = ? WHERE id = ? AND account_id = ?").bind(name, id, accountId);
export const deletePasskey = (db, id, accountId) => db.prepare("DELETE FROM passkeys WHERE id = ? AND account_id = ?").bind(id, accountId);
export const deletePasskeyKeepingOne = (db, id, accountId) =>
  db.prepare("DELETE FROM passkeys WHERE id = ? AND account_id = ? AND (SELECT COUNT(*) FROM passkeys WHERE account_id = ?) > 1").bind(id, accountId, accountId);
export const passkeyById = (db, id, accountId) => db.prepare("SELECT 1 FROM passkeys WHERE id = ? AND account_id = ?").bind(id, accountId);

// sessions
export const insertSession = (db, s) =>
  db.prepare("INSERT INTO sessions (id, account_id, created_at, expires_at, last_seen_at, passkey_at, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(s.id, s.accountId, s.createdAt, s.expiresAt, s.createdAt, s.passkeyAt, s.userAgent);
export const sessionById = (db, id) => db.prepare("SELECT * FROM sessions WHERE id = ?").bind(id);
export const sessionsByAccount = (db, accountId, now) =>
  db.prepare("SELECT id, created_at, last_seen_at, passkey_at, user_agent FROM sessions WHERE account_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY last_seen_at DESC")
    .bind(accountId, now);
export const touchSession = (db, id, at) => db.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?").bind(at, id);
export const setSessionPasskeyAt = (db, id, at) => db.prepare("UPDATE sessions SET passkey_at = ? WHERE id = ?").bind(at, id);
export const revokeSession = (db, id, accountId, at) => db.prepare("UPDATE sessions SET revoked_at = ? WHERE id = ? AND account_id = ? AND revoked_at IS NULL").bind(at, id, accountId);
export const revokeSessionsByAccount = (db, accountId, at) => db.prepare("UPDATE sessions SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL").bind(at, accountId);
export const sessionByIdForAccount = (db, id, accountId) => db.prepare("SELECT id FROM sessions WHERE id = ? AND account_id = ? AND revoked_at IS NULL").bind(id, accountId);

// login codes
export const insertCode = (db, c) =>
  db.prepare("INSERT INTO login_codes (id, email, code_hash, session_nonce, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(c.id, c.email, c.codeHash, c.sessionNonce, c.createdAt, c.expiresAt);
export const latestOpenCode = (db, email, nonce, now) =>
  db.prepare("SELECT * FROM login_codes WHERE email = ? AND session_nonce = ? AND used_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1").bind(email, nonce, now);
export const bumpCodeAttempts = (db, id) => db.prepare("UPDATE login_codes SET attempts = attempts + 1 WHERE id = ?").bind(id);
export const markCodeUsed = (db, id, at) => db.prepare("UPDATE login_codes SET used_at = ? WHERE id = ? AND used_at IS NULL").bind(at, id);

// invitations
export const insertInvitation = (db, i) =>
  db.prepare("INSERT INTO invitations (id, email, lang, invited_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(i.id, i.email, i.lang, i.invitedBy, i.createdAt, i.expiresAt);
export const activeInvitationByEmail = (db, email, now) =>
  db.prepare("SELECT * FROM invitations WHERE email = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1").bind(email, now);
export const invitationById = (db, id) => db.prepare("SELECT * FROM invitations WHERE id = ?").bind(id);
export const listInvitations = (db, now) =>
  db.prepare("SELECT id, email, lang, invited_by, created_at, expires_at FROM invitations WHERE accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC")
    .bind(now);
export const acceptInvitation = (db, id, at) => db.prepare("UPDATE invitations SET accepted_at = ? WHERE id = ?").bind(at, id);
export const revokeInvitation = (db, id, at) => db.prepare("UPDATE invitations SET revoked_at = ? WHERE id = ? AND accepted_at IS NULL").bind(at, id);
export const extendInvitation = (db, id, expiresAt) => db.prepare("UPDATE invitations SET expires_at = ? WHERE id = ?").bind(expiresAt, id);

// rate limits
export const rateLimitGet = (db, key) => db.prepare("SELECT window_start, count FROM rate_limits WHERE key = ?").bind(key);
export const rateLimitPut = (db, key, windowStart, count) =>
  db.prepare("INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET window_start = excluded.window_start, count = excluded.count")
    .bind(key, windowStart, count);

// history (append-only: no UPDATE or DELETE on this table anywhere in this file)
export const insertHistory = (db, h) =>
  db.prepare("INSERT INTO history (at, actor_account_id, action, target_type, target_id, details, ip_hash) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(h.at, h.actor, h.action, h.targetType, h.targetId, h.details, h.ipHash);
// Only inserts if the given passkey no longer exists — lets a history write ride in the same
// batch as a conditional DELETE without recording a mutation that the DELETE didn't perform.
export const insertHistoryIfPasskeyGone = (db, h, passkeyId) =>
  db.prepare("INSERT INTO history (at, actor_account_id, action, target_type, target_id, details, ip_hash) SELECT ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM passkeys WHERE id = ?)")
    .bind(h.at, h.actor, h.action, h.targetType, h.targetId, h.details, h.ipHash, passkeyId);
export function listHistory(db, { beforeId, limit, actions, accountId }) {
  const where = [];
  const args = [];
  if (beforeId) { where.push("h.id < ?"); args.push(beforeId); }
  if (actions && actions.length) { where.push(`h.action IN (${actions.map(() => "?").join(",")})`); args.push(...actions); }
  if (accountId) { where.push("(h.actor_account_id = ? OR (h.target_type = 'account' AND h.target_id = ?))"); args.push(accountId, accountId); }
  const sql = `SELECT h.*, a.email AS actor_email,
                      p.id AS actor_person_id, p.nickname AS actor_nickname, p.first_name AS actor_first_name, p.last_name AS actor_last_name, p.display_name AS actor_display_name
               FROM history h LEFT JOIN accounts a ON a.id = h.actor_account_id LEFT JOIN people p ON p.id = a.person_id
               ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY h.id DESC LIMIT ?`;
  return db.prepare(sql).bind(...args, limit);
}

// people
export const PERSON_COLS = "id, first_name, last_name, maiden_name, nickname, sex, display_name, birth_date, birth_place, death_date, death_place, deceased, email, phone, residence, notes, unverified, created_at, updated_at, updated_by";
export const insertPerson = (db, p) =>
  db.prepare(`INSERT INTO people (${PERSON_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(p.id, p.first_name, p.last_name, p.maiden_name, p.nickname, p.sex, p.display_name, p.birth_date, p.birth_place, p.death_date, p.death_place, p.deceased, p.email, p.phone, p.residence, p.notes, p.unverified, p.created_at, p.updated_at, p.updated_by);
export const personById = (db, id) => db.prepare(`SELECT ${PERSON_COLS} FROM people WHERE id = ?`).bind(id);
export const personByEmail = (db, email) => db.prepare(`SELECT ${PERSON_COLS} FROM people WHERE email = ? COLLATE NOCASE ORDER BY created_at LIMIT 1`).bind(email);
export const listPeople = (db) =>
  db.prepare(`SELECT p.*, a.id AS account_id, a.email AS account_email FROM people p LEFT JOIN accounts a ON a.person_id = p.id ORDER BY p.last_name, p.first_name, p.display_name`);
// fields: object of column → value; only the given columns change.
export function updatePerson(db, id, fields, updatedAt, updatedBy) {
  const keys = Object.keys(fields);
  const sets = [...keys.map((k) => `${k} = ?`), "updated_at = ?", "updated_by = ?"].join(", ");
  return db.prepare(`UPDATE people SET ${sets} WHERE id = ?`).bind(...keys.map((k) => fields[k]), updatedAt, updatedBy, id);
}
export const deletePerson = (db, id) => db.prepare("DELETE FROM people WHERE id = ?").bind(id);
export const personRefCount = (db, id) =>
  db.prepare(`SELECT (SELECT COUNT(*) FROM parent_of WHERE parent_id = ?1 OR child_id = ?1)
                   + (SELECT COUNT(*) FROM partner_of WHERE a_id = ?1 OR b_id = ?1)
                   + (SELECT COUNT(*) FROM accounts WHERE person_id = ?1)
                   + (SELECT COUNT(*) FROM join_requests WHERE matched_person_id = ?1)
                   + (SELECT COUNT(*) FROM media WHERE owner_person_id = ?1) AS n`).bind(id);

// person links (social handles)
export const listLinks = (db) => db.prepare("SELECT id, person_id, kind, label, url FROM person_links ORDER BY person_id, kind, id");
export const linksByPerson = (db, personId) => db.prepare("SELECT id, person_id, kind, label, url FROM person_links WHERE person_id = ? ORDER BY kind, id").bind(personId);
export const deleteLinksByPerson = (db, personId) => db.prepare("DELETE FROM person_links WHERE person_id = ?").bind(personId);
export const insertLink = (db, l) => db.prepare("INSERT INTO person_links (id, person_id, kind, label, url) VALUES (?, ?, ?, ?, ?)").bind(l.id, l.person_id, l.kind, l.label, l.url);

// relationships
export const listParents = (db) => db.prepare("SELECT parent_id, child_id FROM parent_of");
export const parentsOf = (db, childId) => db.prepare("SELECT parent_id FROM parent_of WHERE child_id = ?").bind(childId);
export const parentEdge = (db, parentId, childId) => db.prepare("SELECT 1 FROM parent_of WHERE parent_id = ? AND child_id = ?").bind(parentId, childId);
export const insertParent = (db, parentId, childId) => db.prepare("INSERT INTO parent_of (parent_id, child_id) VALUES (?, ?)").bind(parentId, childId);
export const deleteParent = (db, parentId, childId) => db.prepare("DELETE FROM parent_of WHERE parent_id = ? AND child_id = ?").bind(parentId, childId);
export const listPartners = (db) => db.prepare("SELECT a_id, b_id, kind, start_year, end_year FROM partner_of");
export const upsertPartner = (db, e) =>
  db.prepare("INSERT INTO partner_of (a_id, b_id, kind, start_year, end_year) VALUES (?, ?, ?, ?, ?) ON CONFLICT(a_id, b_id) DO UPDATE SET kind = excluded.kind, start_year = excluded.start_year, end_year = excluded.end_year")
    .bind(e.a_id, e.b_id, e.kind, e.start_year, e.end_year);
export const deletePartner = (db, aId, bId) => db.prepare("DELETE FROM partner_of WHERE a_id = ? AND b_id = ?").bind(aId, bId);
export const partnerEdge = (db, aId, bId) => db.prepare("SELECT 1 FROM partner_of WHERE a_id = ? AND b_id = ?").bind(aId, bId);

// avatars
export const avatarByPerson = (db, personId) => db.prepare("SELECT jpeg, updated_at FROM avatars WHERE person_id = ?").bind(personId);
export const listAvatars = (db) => db.prepare("SELECT person_id, updated_at FROM avatars");
export const avatarStamp = (db, personId) => db.prepare("SELECT updated_at FROM avatars WHERE person_id = ?").bind(personId);
export const upsertAvatar = (db, personId, jpeg, at) =>
  db.prepare("INSERT INTO avatars (person_id, jpeg, updated_at) VALUES (?, ?, ?) ON CONFLICT(person_id) DO UPDATE SET jpeg = excluded.jpeg, updated_at = excluded.updated_at").bind(personId, jpeg, at);
export const deleteAvatar = (db, personId) => db.prepare("DELETE FROM avatars WHERE person_id = ?").bind(personId);

// account ↔ person
export const linkAccountPerson = (db, accountId, personId) => db.prepare("UPDATE accounts SET person_id = ? WHERE id = ?").bind(personId, accountId);
export const accountByPerson = (db, personId) => db.prepare("SELECT id, email FROM accounts WHERE person_id = ?").bind(personId);

// join requests
export const insertJoinRequest = (db, r) =>
  db.prepare("INSERT INTO join_requests (id, first_name, last_name, birth_date, parent_text, email, message, lang, created_at, status, matched_person_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(r.id, r.first_name, r.last_name, r.birth_date, r.parent_text, r.email, r.message, r.lang, r.created_at, r.status, r.matched_person_id);
export const joinRequestById = (db, id) => db.prepare("SELECT * FROM join_requests WHERE id = ?").bind(id);
export const deletePendingJoinRequests = (db, email) => db.prepare("DELETE FROM join_requests WHERE email = ? AND status = 'pending'").bind(email);
export const listJoinRequests = (db) =>
  db.prepare("SELECT * FROM join_requests ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC LIMIT 200");
export const decideJoinRequest = (db, id, status, personId, decidedBy, at, note) =>
  db.prepare("UPDATE join_requests SET status = ?, matched_person_id = ?, decided_by = ?, decided_at = ?, note = ? WHERE id = ? AND status = 'pending'").bind(status, personId, decidedBy, at, note, id);
export const grantedJoinRequestByEmail = (db, email) =>
  db.prepare("SELECT matched_person_id FROM join_requests WHERE email = ? AND status IN ('approved', 'auto') AND matched_person_id IS NOT NULL ORDER BY created_at DESC LIMIT 1").bind(email);
export const listAdmins = (db) => db.prepare("SELECT id, email, lang FROM accounts WHERE role = 'admin' AND disabled_at IS NULL ORDER BY created_at");

// event reminders
// What has already been mailed recently, so a cron that fires twice does not mail the family twice.
export const historySince = (db, action, at) =>
  db.prepare("SELECT at, target_id, details FROM history WHERE action = ? AND at >= ?").bind(action, at);

export const setNotifyEvents = (db, id, v) => db.prepare("UPDATE accounts SET notify_events = ? WHERE id = ?").bind(v, id);
export const listNotifyAccounts = (db) =>
  db.prepare("SELECT id, email, lang, person_id FROM accounts WHERE notify_events = 1 AND disabled_at IS NULL AND person_id IS NOT NULL");
export const setNewsSeenAt = (db, id, at) => db.prepare("UPDATE accounts SET news_seen_at = ? WHERE id = ?").bind(at, id);

// media (SP3): owner fills a cap slot; media_people rows are tags — pure pointers.
// The cap is enforced by the insert, not by a count taken beforehand: two uploads arriving together
// would both read the same count and both go through. meta.changes === 0 means the cap refused it.
export const insertMedia = (db, m) =>
  db.prepare(`INSERT INTO media (id, owner_person_id, kind, caption, year, content_type, size, has_thumb, uploaded_by, created_at)
              SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, ?9
              WHERE (SELECT COUNT(*) FROM media WHERE owner_person_id = ?2) < ${MEDIA_CAP}`)
    .bind(m.id, m.ownerPersonId, m.kind, m.caption, m.year, m.contentType, m.size, m.uploadedBy, m.createdAt);
export const mediaById = (db, id) => db.prepare("SELECT * FROM media WHERE id = ?").bind(id);
export const mediaForPerson = (db, personId) =>
  db.prepare(`SELECT DISTINCT m.* , (m.owner_person_id = ?1) AS owned FROM media m
              LEFT JOIN media_people mp ON mp.media_id = m.id
              WHERE m.owner_person_id = ?1 OR mp.person_id = ?1
              ORDER BY owned DESC, m.kind, m.year IS NULL, m.year, m.created_at`).bind(personId);
export const countOwnedMedia = (db, personId) => db.prepare("SELECT COUNT(*) AS n FROM media WHERE owner_person_id = ?").bind(personId);
export const updateMediaMeta = (db, id, caption, year) => db.prepare("UPDATE media SET caption = ?, year = ? WHERE id = ?").bind(caption, year, id);
export const setMediaOwner = (db, id, personId) => db.prepare("UPDATE media SET owner_person_id = ? WHERE id = ?").bind(personId, id);
export const setMediaThumb = (db, id) => db.prepare("UPDATE media SET has_thumb = 1 WHERE id = ?").bind(id);
export const deleteMedia = (db, id) => db.prepare("DELETE FROM media WHERE id = ?").bind(id);
export const deleteMediaTags = (db, mediaId) => db.prepare("DELETE FROM media_people WHERE media_id = ?").bind(mediaId);
// Every listed file's tags in one query: the listing used to run one per file.
export const tagsForMediaMany = (db, ids) =>
  db.prepare(`SELECT media_id, person_id FROM media_people WHERE media_id IN (${ids.map(() => "?").join(", ")})`).bind(...ids);
export const insertMediaTag = (db, mediaId, personId) => db.prepare("INSERT OR IGNORE INTO media_people (media_id, person_id) VALUES (?, ?)").bind(mediaId, personId);
export const deleteTagsForPerson = (db, personId) => db.prepare("DELETE FROM media_people WHERE person_id = ?").bind(personId);

// ops
export const opsStatus = (db) => db.prepare("SELECT * FROM ops_status WHERE id = 1");
// A finished download clears the last failure in the same statement: the two can never disagree.
export const setBackupAt = (db, at) =>
  db.prepare("UPDATE ops_status SET backup_at = ?, backup_failed_at = NULL, backup_error = NULL WHERE id = 1").bind(at);
export const setBackupFailure = (db, at, reason) =>
  db.prepare("UPDATE ops_status SET backup_failed_at = ?, backup_error = ? WHERE id = 1").bind(at, reason);
export const listAllMedia = (db) => db.prepare("SELECT id, content_type, size, has_thumb FROM media ORDER BY created_at");
export const setOpsStatus = (db, s) =>
  db.prepare(`UPDATE ops_status SET checked_at = ?, domain_expires_at = ?, card_expires_at = ?,
                subscription_renews_at = ?, warnings = ?, error = ?, error_since = ? WHERE id = 1`)
    .bind(s.checkedAt, s.domainExpiresAt, s.cardExpiresAt, s.subscriptionRenewsAt, s.warnings, s.error, s.errorSince);

// gatherings
export const insertGathering = (db, g) =>
  db.prepare("INSERT INTO gatherings (id, on_date, place, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(g.id, g.onDate, g.place, g.note, g.createdBy, g.createdAt);
export const gatheringById = (db, id) => db.prepare("SELECT * FROM gatherings WHERE id = ?").bind(id);
// The one the family is looking at: the soonest that has not happened yet, cancelled or not — a
// cancelled gathering still has to be visible, or people turn up to it.
export const currentGathering = (db, today) =>
  db.prepare("SELECT * FROM gatherings WHERE on_date >= ? ORDER BY on_date LIMIT 1").bind(today);
export const updateGathering = (db, id, g) =>
  db.prepare(`UPDATE gatherings SET on_date = COALESCE(?2, on_date), place = COALESCE(?3, place),
              note = COALESCE(?4, note), cancelled_at = ?5 WHERE id = ?1`)
    .bind(id, g.onDate, g.place, g.note, g.cancelledAt);
export const setRsvp = (db, r) =>
  db.prepare(`INSERT INTO rsvps (gathering_id, person_id, coming, headcount, answered_by, answered_at)
              VALUES (?1, ?2, ?3, ?4, ?5, ?6)
              ON CONFLICT (gathering_id, person_id) DO UPDATE SET
                coming = ?3, headcount = ?4, answered_by = ?5, answered_at = ?6`)
    .bind(r.gatheringId, r.personId, r.coming, r.headcount, r.answeredBy, r.answeredAt);
// Every living relative, with their answer if there is one. on_behalf marks an answer somebody else
// entered — most of the family will never sign in, and their word arrives by telephone.
export const guestList = (db, gatheringId) =>
  db.prepare(`SELECT p.id AS person_id, p.display_name, r.coming, r.headcount, r.answered_at,
                     CASE WHEN r.answered_by IS NOT NULL AND r.answered_by <> COALESCE(acc.id, '') THEN 1 ELSE 0 END AS on_behalf
              FROM people p
              LEFT JOIN rsvps r ON r.person_id = p.id AND r.gathering_id = ?1
              LEFT JOIN accounts acc ON acc.person_id = p.id AND acc.disabled_at IS NULL
              WHERE p.deceased = 0
              ORDER BY p.display_name`).bind(gatheringId);
export const deleteGathering = (db, id) => db.prepare("DELETE FROM gatherings WHERE id = ?").bind(id);
export const deleteRsvpsFor = (db, id) => db.prepare("DELETE FROM rsvps WHERE gathering_id = ?").bind(id);
// Who the site can actually write to about a gathering: living relatives with an address on file.
export const livingWithEmail = (db) =>
  db.prepare("SELECT id, display_name, email FROM people WHERE deceased = 0 AND email IS NOT NULL AND email != ''");
export const unansweredWithEmail = (db, gatheringId) =>
  db.prepare(`SELECT p.id, p.display_name, p.email FROM people p
              LEFT JOIN rsvps r ON r.person_id = p.id AND r.gathering_id = ?1
              WHERE p.deceased = 0 AND p.email IS NOT NULL AND p.email != '' AND r.person_id IS NULL`).bind(gatheringId);
export const markAnnounced = (db, id, at) => db.prepare("UPDATE gatherings SET announced_at = ? WHERE id = ?").bind(at, id);
export const markNudged = (db, id, at) => db.prepare("UPDATE gatherings SET nudged_at = ? WHERE id = ?").bind(at, id);
export const nextGathering = (db, today) =>
  db.prepare("SELECT * FROM gatherings WHERE on_date >= ? AND cancelled_at IS NULL ORDER BY on_date LIMIT 1").bind(today);
