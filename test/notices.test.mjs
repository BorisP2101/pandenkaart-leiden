import assert from "node:assert/strict";
import { classifyNotice } from "../notices.js";
const cases = [
  ["Verleende omgevingsvergunning, sloop stadsbouwhuis en nieuwbouw 157 woningen, Langegracht 72 2312NH Leiden", "granted", ["demolition"]],
  ["Aanvraag omgevingsvergunning, slopen schuurtje t.b.v. bouwen nieuwe schuur, Magdalena Moonsstraat 76", "applied", []],
  ["Aanvraag omgevingsvergunning, wijzigen gebruik naar terras, Aalmarkt 1 2311EC Leiden", "applied", []],
  ["Aanvraag omgevingsvergunning, transformatie kantoor naar woning (nr. 76), Lammenschansweg 76", "applied", ["transformation"]],
  ["Verleende omgevingsvergunning, wijzigen gebruik van sport naar kinderopvang, Montgomerystraat 50", "granted", []],
  ["Verleende omgevingsvergunning, transformatie eengezinswoning naar twee appartementen, Hogewoerd 94", "granted", []],
  ["Aanvraag omgevingsvergunning, wijzigen gebruik tijdelijke anti-leegstand tot aan de geplande renovatie, Boshuizerkade 119", "applied", ["vacancy", "temporary"]],
  ["Verleende omgevingsvergunning, tijdelijk wijzigen gebruik kantoor naar wonen en werkruimte, Langegracht 72", "granted", ["transformation", "temporary"]],
  ["Aanvraag omgevingsvergunning, tijdelijk wijzigen gebruik voor een huwelijk , Langegracht 70D", "applied", []],
  ["Aanvraag omgevingsvergunning, wijzigen gebruik woonfunctie naar logiesfunctie, Da Costastraat 12B", "applied", []],
  ["Geweigerde omgevingsvergunning, transformatie kantoor naar woning, Teststraat 1", "refused", []],
];
for (const [title, phase, signals] of cases) {
  const c = classifyNotice(title);
  assert.equal(c.phase, phase, title);
  assert.deepEqual(c.signals.sort(), signals.sort(), title + " → " + JSON.stringify(c));
}
console.log(`notices: ${cases.length} cases OK`);
