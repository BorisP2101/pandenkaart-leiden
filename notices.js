// Classify a municipal permit notice by its title (Dutch), so that a café terrace
// doesn't count as a "change of use" signal. Pure function, no DOM: test with Node.

export const NOTICE_TYPES = {
  vacancy:        { en: "Vacancy",                   signal: true },
  demolition:     { en: "Demolition (whole building)", signal: true },
  transformation: { en: "Transformation to housing/shelter", signal: true },
  temporary:      { en: "Temporary use",             signal: true },
  partialDemo:    { en: "Minor demolition",          signal: false },
  split:          { en: "Splitting a home",          signal: false },
  business:       { en: "Change of business use",    signal: false },
  event:          { en: "Event / one-off",           signal: false },
  other:          { en: "Other",                     signal: false },
};
export const PHASES = { applied: "Applied", granted: "Granted", refused: "Refused", withdrawn: "Withdrawn", other: "Notice" };

const PARTIAL = /schuur|berging|aanbouw|achterbouw|uitbouw|bijgebouw|dakkapel|dakopbouw|muur|wand|keuken|serre|carport|schoorsteen|kozijn|gevel|\bpui\b|achterpui|vloer|trap|balkon|garage|veranda|erker|overkapping|luifel|badkamer|\bdak\b|\bdam\b|duiker|\bbrug\b|kiosk|\bkas\b|asbest|binnenzijde/;
const HOUSING = /(naar|tot|voor|in)\b[^,]*?(wonen|woning|woon\w*|appartement|studio'?s|kamer|studenten|(?<!kinder|kinderdag|schoolse\s)opvang|logies|bewoning)/;
const FROM_HOME = /(van|transformatie)\s+(een\s+|de\s+)?(\d+[- ]?(laagse\s+)?)?(zelfstandige\s+)?(eengezins|boven)?(woning|woonfunctie|woonruimte)\b|\b(woning|woonfunctie)\s+naar\b/;
const EVENT = /feest|evenementen?(terrein)?\b|festival|\bwk\b|boks|pop-?up|kijken|kermis|concert|slaapzaal|slaaplocatie|el cid|huwelijk|toneel|lustrum|leids ontzet|bezoekers/;
const BUSINESS = /terras|horeca|reclame|alcohol|dienstverlening|praktijk|salon|kapper|restaurant|caf[eé]|kinderopvang|\bkdv\b|\bbso\b|buitenschoolse|winkel naar winkel|detailhandel naar|studio\b|sportschool|pilates|dansgelegenheid|kantoorfunctie en/;
const CHANGE = /transformatie|wijzig\w*\s+(van\s+)?(het\s+)?gebruik|gewijzigd\w*\s+gebruik|functiewijziging|omzetten|gebruik\w*\s.*\bals\b/;

export function classifyNotice(title) {
  const t = (title || "").toLowerCase();
  const phase = /^aanvraag/.test(t) ? "applied"
    : /^verleend/.test(t) ? "granted"
    : /^(geweigerd|weigering)/.test(t) ? "refused"
    : /ingetrokken|buiten behandeling/.test(t) ? "withdrawn" : "other";
  // Only the description, without "Verleende omgevingsvergunning, " in front.
  const d = t.replace(/^[^,]*,\s*/, "");
  const types = new Set();
  if (/leegstand/.test(d)) types.add("vacancy");
  if (/\bsloop|slopen/.test(d)) types.add(PARTIAL.test(d) && !/sloop\s+(en|\/)\s+nieuwbouw|woningen/.test(d) ? "partialDemo" : "demolition");
  if (CHANGE.test(d) || /\btijdelijk/.test(d)) {
    if (EVENT.test(d)) types.add("event");
    else if (HOUSING.test(d) && FROM_HOME.test(d)) types.add("split");
    else if (HOUSING.test(d)) types.add("transformation");
    else if (BUSINESS.test(d)) types.add("business");
    else if (!types.size) types.add("other");
    if (/\btijdelijk/.test(d) && !types.has("event") && !types.has("business") && !types.has("split")) types.add("temporary");
  }
  if (!types.size) types.add("other");
  // A refused or withdrawn permit is shown, but doesn't count as a signal.
  const live = phase !== "refused" && phase !== "withdrawn";
  return { phase, types: [...types], signals: live ? [...types].filter((x) => NOTICE_TYPES[x].signal) : [] };
}
