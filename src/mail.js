import { plural } from "../public/app/events.js";
import { appOrigin } from "./api/common.js";

// Login codes keep a functional sender; everything a family member reads comes from a person.
// Senders and links are configuration: this file names no domain of its own, so the same code runs
// for any family that stands it up. LOGIN_FROM carries the codes; FAMILY_FROM carries everything a
// relative actually reads.
export const loginFrom = (env) => env.MAIL_LOGIN_FROM || `login@${host(env)}`;
export const familyFrom = (env) => env.MAIL_FAMILY_FROM || `rodzina@${host(env)}`;
export const host = (env) => new URL(appOrigin(env)).hostname;
const appUrl = (env, path = "/app/") => `${appOrigin(env)}${path}`;

// Every template writes {app} and {domain} rather than naming a site, the same way the interface
// strings do. They are filled in here, at the one place that actually has the configuration.
const fill = (env, s) => String(s).replaceAll("{app}", appUrl(env)).replaceAll("{domain}", host(env));
const FAMILY_NAME = { pl: "Nasze Korzenie", en: "Our Roots" };
const familyName = (lang) => FAMILY_NAME[lang] || FAMILY_NAME.pl;

const MESSAGES = {
  pl: (code) => ({
    subject: `Kod logowania: ${code}`,
    text: `Twój kod logowania do Naszych Korzeni: ${code}\n\nKod jest ważny 10 minut i działa tylko w przeglądarce, z której poproszono o logowanie.\nJeśli to nie Ty, zignoruj tę wiadomość.`,
  }),
  en: (code) => ({
    subject: `Login code: ${code}`,
    text: `Your login code for Our Roots: ${code}\n\nIt is valid for 10 minutes and only in the browser that asked for it.\nIf this wasn't you, ignore this message.`,
  }),
};

// The only place that talks to a mail provider. Swap the body of this function to change vendor.
export async function sendCode(env, to, code, lang) {
  const { subject, text } = (MESSAGES[lang] || MESSAGES.pl)(code);
  if (env.MAIL_ECHO === "1") console.log(`[mail-echo] to=${to} code=${code}`);
  await env.EMAIL.send({ to, from: { email: loginFrom(env), name: familyName(lang) }, subject: fill(env, subject), text: fill(env, text) });
}

// The first-person story is the founder's own — his mother left him the Drzewo Genealogiczne. Any
// other admin signing that text would be claiming it happened to them, so "own" switches the whole
// paragraph to the family's plural voice, which is also what an unsigned invitation uses.
const INVITES = {
  pl: (inviter, email, own) => ({
    subject: inviter ? `${inviter} zaprasza Cię do Naszych Korzeni` : "Nasze Korzenie — nasza rodzinna strona",
    text: [
      "Cześć,",
      "",
      ...(own
        ? ["Mama zostawiła mi Drzewo Genealogiczne — spisaną historię naszej rodziny.",
           "Od jakiegoś czasu próbuję poskładać ją do kupy i uzupełnić białe plamy, więc",
           "zrobiłem z tego stronę — Nasze Korzenie: drzewo, stare zdjęcia, dokumenty",
           "i to, co u nas słychać."]
        : ["W rodzinie zostało po latach Drzewo Genealogiczne — spisana historia rodziny.",
           "Od jakiegoś czasu próbujemy poskładać ją do kupy i uzupełnić białe plamy, więc",
           "zrobiliśmy z tego stronę — Nasze Korzenie: drzewo, stare zdjęcia, dokumenty",
           "i to, co u nas słychać."]),
      "",
      "Może kiedyś uda się zebrać całą rodzinę w jednym miejscu. Na razie chociaż tutaj.",
      "",
      `Wejdź na {app} i wpisz swój adres: ${email}. Przyjdzie kod,`,
      "przepiszesz go i jesteś w środku — bez hasła i bez zakładania konta. Strona jest",
      "prywatna, nie znajdzie jej wyszukiwarka.",
      "",
      own ? "Jeśli coś wiesz lepiej ode mnie — popraw, dopisz, dorzuć zdjęcie. O to chodzi."
          : "Jeśli coś wiesz lepiej od nas — popraw, dopisz, dorzuć zdjęcie. O to chodzi.",
      "",
      inviter || "Nasze Korzenie",
    ].join("\n"),
  }),
  en: (inviter, email, own) => ({
    subject: inviter ? `${inviter} is inviting you to Our Roots` : "Our Roots — our family site",
    text: [
      "Hello,",
      "",
      ...(own
        ? ["My mother left me a Drzewo Genealogiczne — a written history of our family.",
           "I have been trying to piece it together and fill in the blanks, so I turned it into",
           "a site called Our Roots: the tree, old photographs, documents, and what is going on with us now."]
        : ["A Drzewo Genealogiczne — a written history of our family — came down to us.",
           "We have been trying to piece it together and fill in the blanks, so we turned it into",
           "a site called Our Roots: the tree, old photographs, documents, and what is going on with us now."]),
      "",
      "Maybe one day we can get the whole family together in one place. For now, at least here.",
      "",
      `Go to {app} and enter your address: ${email}. A code will arrive,`,
      "you type it in, and you are there — no password, no account to create. The site is",
      "private and search engines cannot find it.",
      "",
      own ? "If you know something better than I do, correct it, add to it, put a photo in."
          : "If you know something better than we do, correct it, add to it, put a photo in.",
      "That is the point.",
      "",
      inviter || "Our Roots",
    ].join("\n"),
  }),
};

// inviter: { name, email } of the person inviting; null falls back to the family.
// bcc: admin addresses that keep a copy of every invitation sent.
export async function sendInvitation(env, to, lang, inviter = null, bcc = []) {
  const { subject, text } = (INVITES[lang] || INVITES.pl)(inviter?.name || null, to, Boolean(inviter?.founder));
  const from = { email: familyFrom(env), name: inviter?.name || familyName(lang) };
  await env.EMAIL.send({
    to, from, subject: fill(env, subject), text: fill(env, text),
    ...(inviter?.email ? { replyTo: inviter.email } : {}),
    ...(bcc.length ? { bcc } : {}),
  });
}

const JOIN_NOTICES = {
  pl: (name, auto) => ({
    subject: `Nowa prośba o dołączenie: ${name}`,
    text: auto
      ? `${name} poprosił(a) o dołączenie do Naszych Korzeni i został(a) zatwierdzony(a) automatycznie (adres e-mail był już w drzewie).\n\nSzczegóły: Administracja → Zaproszenia.`
      : `${name} prosi o dołączenie do Naszych Korzeni.\n\nZatwierdź lub odrzuć: Administracja → Zaproszenia.`,
  }),
  en: (name, auto) => ({
    subject: `New join request: ${name}`,
    text: auto
      ? `${name} asked to join Our Roots and was auto-approved (the email address was already in the tree).\n\nDetails: Admin → Invitations.`
      : `${name} asks to join Our Roots.\n\nApprove or reject: Admin → Invitations.`,
  }),
};

export async function sendJoinNotice(env, to, lang, name, auto = false) {
  const { subject, text } = (JOIN_NOTICES[lang] || JOIN_NOTICES.pl)(name, auto);
  await env.EMAIL.send({ to, from: { email: familyFrom(env), name: familyName(lang) }, subject: fill(env, subject), text: fill(env, text) });
}

const ADMIN_GRANTED = {
  pl: () => ({
    subject: "Masz teraz uprawnienia administratora",
    text: [
      "Cześć,",
      "",
      "Od teraz jesteś administratorem Naszych Korzeni. Możesz zapraszać kolejne osoby,",
      "poprawiać i dodawać ludzi w drzewie, przenosić zdjęcia i dokumenty między osobami",
      "oraz zarządzać kontami.",
      "",
      "Zakładka Administracja: {app}admin",
      "",
      "Nasze Korzenie",
    ].join("\n"),
  }),
  en: () => ({
    subject: "You are now an admin",
    text: [
      "Hello,",
      "",
      "You are now an admin of Our Roots. You can invite more people, correct and add",
      "people in the tree, move photographs and documents between them, and manage",
      "accounts.",
      "",
      "The Admin tab: {app}admin",
      "",
      "Our Roots",
    ].join("\n"),
  }),
};

export async function sendAdminGranted(env, to, lang) {
  const { subject, text } = (ADMIN_GRANTED[lang] || ADMIN_GRANTED.pl)();
  await env.EMAIL.send({ to, from: { email: familyFrom(env), name: familyName(lang) }, subject: fill(env, subject), text: fill(env, text) });
}

const JOINED_NOTICES = {
  pl: (name, email) => ({
    subject: `${name} jest już na stronie`,
    text: `${name} (${email}) zalogował(a) się pierwszy raz — zaproszenie przyjęte.\n\nStrona: {app}`,
  }),
  en: (name, email) => ({
    subject: `${name} has joined`,
    text: `${name} (${email}) signed in for the first time — the invitation was accepted.\n\nThe site: {app}`,
  }),
};

// Admins learn by mail when an invitation turns into a real member; never blocks that first login.
export async function sendJoinedNotice(env, to, lang, name, email) {
  const { subject, text } = (JOINED_NOTICES[lang] || JOINED_NOTICES.pl)(name, email);
  await env.EMAIL.send({ to, from: { email: familyFrom(env), name: familyName(lang) }, subject: fill(env, subject), text: fill(env, text) });
}

const EVENT_NOTICES = {
  pl: ({ type, name, years, inDays }) => type === "birthday"
    ? { subject: inDays ? `Za tydzień urodziny: ${name}` : `Dziś urodziny: ${name}`,
        text: `${name} kończy ${years} ${plural(years, "pl", { one: "rok", few: "lata", many: "lat", other: "lat" })}${inDays ? " za 7 dni" : " dzisiaj"}.\n\nSzczegóły: {app}\nNie chcesz przypomnień? Wyłącz je w zakładce Konto.` }
    : { subject: inDays ? `Za tydzień ${years}. rocznica śmierci: ${name}` : `Dziś ${years}. rocznica śmierci: ${name}`,
        text: `${inDays ? "Za 7 dni" : "Dzisiaj"} mija ${years}. rocznica śmierci: ${name}.\n\nSzczegóły: {app}\nNie chcesz przypomnień? Wyłącz je w zakładce Konto.` },
  en: ({ type, name, years, inDays }) => type === "birthday"
    ? { subject: inDays ? `Birthday in a week: ${name}` : `Birthday today: ${name}`,
        text: `${name} turns ${years}${inDays ? " in 7 days" : " today"}.\n\nDetails: {app}\nDon't want reminders? Turn them off under Account.` }
    : { subject: inDays ? `In a week: ${years} ${plural(years, "en", { one: "year", other: "years" })} since ${name} died` : `Today: ${years} ${plural(years, "en", { one: "year", other: "years" })} since ${name} died`,
        text: `${inDays ? "In 7 days" : "Today"} it is ${years} ${plural(years, "en", { one: "year", other: "years" })} since ${name} died.\n\nDetails: {app}\nDon't want reminders? Turn them off under Account.` },
};

export async function sendEventNotice(env, to, lang, notice) {
  const { subject, text } = (EVENT_NOTICES[lang] || EVENT_NOTICES.pl)(notice);
  await env.EMAIL.send({ to, from: { email: familyFrom(env), name: familyName(lang) }, subject: fill(env, subject), text: fill(env, text) });
}

// The monthly letter to the admins. Two rules run through all of it.
//
// Every date is written out in full and paired with a count of days: "2 kwietnia 2027" alone means
// nothing to somebody reading in August, and "za 224 dni" alone is a number with no verb.
//
// And a fact the site could not establish is printed as "I do not know", never quietly left out and
// never counted as good news. With no billing token — the default — the card and the subscription are
// simply unknown, and a letter that answered that with "wszystko działa" would be the single most
// dangerous message this system could send.
const OPS_WARNINGS = {
  pl: {
    backup_failed: "Ostatnie pobieranie kopii zapasowej nie doszło do końca — plik, który wtedy zapisałeś, jest niepełny. Pobierz kopię jeszcze raz i sprawdź, czy się kończy.",
    checks_never: "Strona jeszcze ani razu sama siebie nie sprawdziła — codzienne zadanie uruchomi się najbliższej nocy. Jeśli po niej ta uwaga nie zniknie, to znaczy, że zadanie nie działa.",
    checks_stale: "Strona przestała sprawdzać samą siebie — od ponad trzech dni nic nie zaglądało do dat powyżej. Popsuło się codzienne zadanie, więc te daty mogą już być nieaktualne.",
    domain_unknown: "Wpisz datę odnowienia domeny do ustawień strony (DOMAIN_RENEWS_AT w pliku wrangler.toml). Bez niej nikt Cię nie ostrzeże, że domena się kończy.",
    domain_soon: "Odnów domenę {domain} u rejestratora. Jeśli wygaśnie, strona zniknie z internetu razem ze zdjęciami i drzewem.",
    card_soon: "Podmień kartę w Cloudflare — inaczej płatność się nie powiedzie.",
    backup_never: "Pobierz pierwszą kopię zapasową i schowaj ją gdzieś poza Cloudflare.",
    backup_stale: "Pobierz świeżą kopię zapasową — ostatnia ma już ponad dwa miesiące.",
    check_failing: "Sprawdzanie rozliczeń w Cloudflare nie udaje się od ponad tygodnia. Najpewniej token stracił ważność.",
  },
  en: {
    backup_failed: "The last backup download did not finish — the file saved that time is incomplete. Download it again and check that it completes.",
    checks_never: "The site has not once checked itself yet — the daily job runs overnight. If this note is still here tomorrow, the job is not running.",
    checks_stale: "The site has stopped checking itself — nothing has looked at the dates above for over three days. The daily job has broken, so those dates may already be out of date.",
    domain_unknown: "Put the domain's renewal date into the site's settings (DOMAIN_RENEWS_AT in wrangler.toml). Without it nothing will warn you that the domain is running out.",
    domain_soon: "Renew {domain} with the registrar. If it lapses, the site disappears from the internet, photographs and family tree with it.",
    card_soon: "Replace the card at Cloudflare, or the next payment will fail.",
    backup_never: "Download the first backup and keep it somewhere other than Cloudflare.",
    backup_stale: "Download a fresh backup — the last one is over two months old.",
    check_failing: "The Cloudflare billing check has been failing for over a week. The token has most likely expired.",
  },
};

const OPS_LETTERS = {
  pl: (s) => {
    const date = (at) => new Intl.DateTimeFormat("pl", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(at * 1000));
    const days = (n) => `${n} ${plural(n, "pl", { one: "dzień", few: "dni", many: "dni", other: "dni" })}`;
    const left = (at) => Math.floor((at - s.at) / 86400);

    const facts = [];
    if (s.domain_expires_at == null) {
      facts.push("Nie wiem, do kiedy opłacona jest domena {domain} — w ustawieniach strony nie ma tej daty.");
    } else {
      const n = left(s.domain_expires_at);
      facts.push(n > 0 ? `Domena {domain} jest opłacona do ${date(s.domain_expires_at)} — jeszcze przez ${days(n)}.`
        : n === 0 ? `Domena {domain} jest opłacona tylko do dzisiaj, ${date(s.domain_expires_at)}.`
        : `Domena {domain} miała zostać odnowiona ${date(s.domain_expires_at)}, ${days(-n)} temu. Sprawdź u rejestratora, czy na pewno została.`);
    }
    if (s.card_expires_at == null) {
      facts.push("Nie wiem, kiedy traci ważność karta w Cloudflare — strona nie ma wglądu w rozliczenia.");
    } else {
      const n = left(s.card_expires_at);
      facts.push(n > 0 ? `Karta w Cloudflare traci ważność ${date(s.card_expires_at)} — za ${days(n)}.`
        : n === 0 ? `Karta w Cloudflare traci ważność dzisiaj, ${date(s.card_expires_at)}.`
        : `Karta w Cloudflare straciła ważność ${date(s.card_expires_at)}, ${days(-n)} temu.`);
    }
    if (s.subscription_renews_at == null) {
      facts.push("Nie wiem, kiedy odnawia się abonament w Cloudflare — strona nie ma wglądu w rozliczenia.");
    } else {
      const n = left(s.subscription_renews_at);
      facts.push(n > 0 ? `Abonament w Cloudflare odnowi się ${date(s.subscription_renews_at)} — za ${days(n)}. Dzieje się to automatycznie, co miesiąc.`
        : n === 0 ? `Abonament w Cloudflare odnawia się dzisiaj, ${date(s.subscription_renews_at)}. Dzieje się to automatycznie, co miesiąc.`
        : `Abonament w Cloudflare miał się odnowić ${date(s.subscription_renews_at)}, ${days(-n)} temu.`);
    }
    if (!s.backup_at) {
      facts.push("Nikt jeszcze nie pobrał kopii zapasowej.");
    } else {
      const n = -left(s.backup_at);
      facts.push(n <= 0 ? `Ostatnią kopię zapasową pobrano dzisiaj, ${date(s.backup_at)}.`
        : `Ostatnią kopię zapasową pobrano ${date(s.backup_at)}, ${days(n)} temu.`);
    }

    // A date that has already gone by is never good news, even when no warning covers it. The monthly
    // subscription has no warning at all by design, so a payment that failed leaves nothing behind but
    // a renewal date in the past — and that must not be printed under "wszystko opłacone".
    const gone = (at) => at != null && at < s.at;
    const overdue = gone(s.domain_expires_at) || gone(s.card_expires_at) || gone(s.subscription_renews_at);
    const unknown = s.domain_expires_at == null || s.card_expires_at == null || s.subscription_renews_at == null;
    const todo = s.warnings.map((w) => OPS_WARNINGS.pl[w]).filter(Boolean);
    const verdict = todo.length
      ? ["Co trzeba zrobić:", ...todo.flatMap((line) => ["", line])]
      : overdue
        ? ["Któraś z dat powyżej już minęła. Sprawdź w panelu Cloudflare i u rejestratora, czy wszystko na pewno się odnowiło — jeśli płatność się nie udała, nikt mi o tym nie powie."]
        : unknown
          ? ["Z tego, co umiem sprawdzić, nic nie wymaga uwagi. Ale tego, czego nie wiem — a napisałem o tym wyżej — nie sprawdzi za Ciebie nikt."]
          : ["Wszystko jest opłacone, sprawdzone i nic nie wymaga uwagi."];

    return {
      subject: todo.length ? "Nasze Korzenie: jest co zrobić"
        : overdue ? "Nasze Korzenie: sprawdź, czy wszystko się odnowiło"
        : unknown ? "Nasze Korzenie: strona paru rzeczy o sobie nie wie"
        : "Nasze Korzenie: wszystko opłacone i sprawdzone",
      text: [
        "Cześć,",
        "",
        "pierwszy dzień miesiąca, więc krótko o tym, co u strony rodzinnej.",
        "",
        ...facts,
        "",
        ...verdict,
        "",
        "Kopię zapasową pobierzesz w Administracji → Kopia zapasowa:",
        "{app}admin",
        "",
        s.admins > 1
          ? `Ten list poszedł do ${s.admins} osób, które mają dostęp do administracji strony.`
          : "Ten list poszedł tylko do Ciebie — jesteś jedynym administratorem strony. Gdyby Cię\nzabrakło, nikt inny go nie dostanie. Warto, żeby administratorów było dwoje, najlepiej\nz pocztą u dwóch różnych dostawców.",
        "",
        "Ten list przychodzi pierwszego dnia miesiąca. Jeśli kiedyś nie przyjdzie,",
        "to też jest wiadomość — sprawdź, czy strona żyje.",
        "",
        "Nasze Korzenie",
      ].join("\n"),
    };
  },

  en: (s) => {
    const date = (at) => new Intl.DateTimeFormat("en", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(at * 1000));
    const days = (n) => `${n} ${plural(n, "en", { one: "day", other: "days" })}`;
    const left = (at) => Math.floor((at - s.at) / 86400);

    const facts = [];
    if (s.domain_expires_at == null) {
      facts.push("I do not know how long the domain {domain} is paid up for — the date is not in the site's settings.");
    } else {
      const n = left(s.domain_expires_at);
      facts.push(n > 0 ? `The domain {domain} is paid up until ${date(s.domain_expires_at)} — ${days(n)} left.`
        : n === 0 ? `The domain {domain} is paid up only until today, ${date(s.domain_expires_at)}.`
        : `The domain {domain} was due to be renewed on ${date(s.domain_expires_at)}, ${days(-n)} ago. Check with the registrar that it actually was.`);
    }
    if (s.card_expires_at == null) {
      facts.push("I do not know when the card at Cloudflare expires — the site cannot see the billing details.");
    } else {
      const n = left(s.card_expires_at);
      facts.push(n > 0 ? `The card at Cloudflare expires on ${date(s.card_expires_at)} — in ${days(n)}.`
        : n === 0 ? `The card at Cloudflare expires today, ${date(s.card_expires_at)}.`
        : `The card at Cloudflare expired on ${date(s.card_expires_at)}, ${days(-n)} ago.`);
    }
    if (s.subscription_renews_at == null) {
      facts.push("I do not know when the Cloudflare subscription renews — the site cannot see the billing details.");
    } else {
      const n = left(s.subscription_renews_at);
      facts.push(n > 0 ? `The Cloudflare subscription renews on ${date(s.subscription_renews_at)} — in ${days(n)}. That happens by itself, every month.`
        : n === 0 ? `The Cloudflare subscription renews today, ${date(s.subscription_renews_at)}. That happens by itself, every month.`
        : `The Cloudflare subscription was due to renew on ${date(s.subscription_renews_at)}, ${days(-n)} ago.`);
    }
    if (!s.backup_at) {
      facts.push("Nobody has ever downloaded a backup.");
    } else {
      const n = -left(s.backup_at);
      facts.push(n <= 0 ? `The last backup was downloaded today, ${date(s.backup_at)}.`
        : `The last backup was downloaded on ${date(s.backup_at)}, ${days(n)} ago.`);
    }

    // See the Polish builder: a date already in the past is never an all-clear, warning or no warning.
    const gone = (at) => at != null && at < s.at;
    const overdue = gone(s.domain_expires_at) || gone(s.card_expires_at) || gone(s.subscription_renews_at);
    const unknown = s.domain_expires_at == null || s.card_expires_at == null || s.subscription_renews_at == null;
    const todo = s.warnings.map((w) => OPS_WARNINGS.en[w]).filter(Boolean);
    const verdict = todo.length
      ? ["What needs doing:", ...todo.flatMap((line) => ["", line])]
      : overdue
        ? ["One of the dates above has already passed. Check the Cloudflare dashboard and the registrar that everything really did renew — if a payment failed, nobody will tell me about it."]
        : unknown
          ? ["Of what I can check, nothing needs attention. But what I do not know — and I have said so above — nobody will check for you."]
          : ["Everything is paid up, checked, and nothing needs attention."];

    return {
      subject: todo.length ? "Our Roots: something needs doing"
        : overdue ? "Our Roots: check that everything renewed"
        : unknown ? "Our Roots: there are things the site cannot check"
        : "Our Roots: everything is paid up and checked",
      text: [
        "Hello,",
        "",
        "it is the first of the month, so here is a short word on how the family site is doing.",
        "",
        ...facts,
        "",
        ...verdict,
        "",
        "You can download the backup under Admin → Backup:",
        "{app}admin",
        "",
        s.admins > 1
          ? `This letter went to ${s.admins} people who can get into the site's admin pages.`
          : "This letter went only to you — you are the site's only admin. If you were not here,\nnobody else would receive it. It is worth having a second admin, ideally with mail at a\ndifferent provider.",
        "",
        "This letter arrives on the first of each month. If it ever stops arriving,",
        "that is a message too — check whether the site is still alive.",
        "",
        "Our Roots",
      ].join("\n"),
    };
  },
};

export async function sendOpsLetter(env, to, lang, status) {
  const { subject, text } = (OPS_LETTERS[lang] || OPS_LETTERS.pl)(status);
  await env.EMAIL.send({ to, from: { email: familyFrom(env), name: familyName(lang) }, subject: fill(env, subject), text: fill(env, text) });
}

// A gathering speaks for the family, not for whoever pressed the button: it is the family's event,
// and the first-person story that belongs to the founder has no place in it.
const GATHERINGS = {
  pl: (g, kind, signature) => ({
    subject: kind === "announce" ? `Spotkanie rodzinne — ${g.on_date}`
      : kind === "nudge" ? "Dasz znać, czy przyjedziesz?"
      : kind === "day" ? "Dzisiaj spotkanie rodzinne" : "Za tydzień spotkanie rodzinne",
    text: [
      "Cześć,",
      "",
      kind === "announce" ? "Szykuje się spotkanie całej rodziny."
        : kind === "nudge" ? "Zbieramy jeszcze odpowiedzi na spotkanie rodzinne."
        : kind === "day" ? "Dzisiaj się spotykamy." : "Za tydzień się spotykamy.",
      "",
      `Kiedy: ${g.on_date}`,
      ...(g.place ? [`Gdzie: ${g.place}`] : []),
      ...(g.note ? ["", g.note] : []),
      "",
      kind === "nudge"
        ? `Daj znać, czy Cię będzie — zajmie to chwilę: {app}gathering`
        : `Kto już się wybiera i czy Ty też — {app}gathering`,
      "",
      "Jeśli nie masz jeszcze konta, wejdź na {app} i wpisz swój adres — przyjdzie kod,",
      "przepiszesz go i jesteś w środku. Bez hasła.",
      "",
      signature,
    ].join("\n"),
  }),
  en: (g, kind, signature) => ({
    subject: kind === "announce" ? `Family gathering — ${g.on_date}`
      : kind === "nudge" ? "Will you be coming?"
      : kind === "day" ? "The family gathering is today" : "The family gathering is in a week",
    text: [
      "Hello,",
      "",
      kind === "announce" ? "The whole family is getting together."
        : kind === "nudge" ? "We are still collecting answers for the family gathering."
        : kind === "day" ? "We are meeting today." : "We are meeting in a week.",
      "",
      `When: ${g.on_date}`,
      ...(g.place ? [`Where: ${g.place}`] : []),
      ...(g.note ? ["", g.note] : []),
      "",
      kind === "nudge"
        ? "Let us know whether you can make it — it takes a moment: {app}gathering"
        : "Who is coming, and whether you are — {app}gathering",
      "",
      "If you do not have an account yet, go to {app} and enter your address. A code will arrive,",
      "you type it in, and you are there. No password.",
      "",
      signature,
    ].join("\n"),
  }),
};

export async function sendGatheringMail(env, to, lang, gathering, kind, signature = null) {
  const { subject, text } = (GATHERINGS[lang] || GATHERINGS.pl)(gathering, kind, signature || familyName(lang));
  await env.EMAIL.send({ to, from: { email: familyFrom(env), name: familyName(lang) }, subject: fill(env, subject), text: fill(env, text) });
}
