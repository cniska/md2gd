const UNCITED_FAMILIES = ["AC", "D", "TS"];
const DEFINITION = /^- \*\*([A-Z]+-[\w.]+)\*\* —/gm;
const CRITERION_LINE = /^- \*\*AC-\d+\*\* —.*$/gm;
const CITATION_LIST = /\(([A-Z]+-\w+(?:, [A-Z]+-\w+)*)\)\s*$/;
const TEST_NAME = /\btest(?:\.todo|\.failing)?\(\s*["'`]([^"'`]*)/g;
const CITED_CRITERIA = /^((?:AC-\d+ )+)/;
const WHOLE = /^([A-Z]+)-[1-9]\d*$/;

const captures = (text: string, pattern: RegExp): string[] =>
  [...text.matchAll(pattern)].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
const familyOf = (id: string): string => id.split("-")[0] ?? id;
export function citationProblems(spec: string, acceptanceSources: readonly string[]): string[] {
  const ids = captures(spec, DEFINITION);
  const criteria = ids.filter((id) => familyOf(id) === "AC");
  const names = acceptanceSources.flatMap((source) => captures(source, TEST_NAME));
  if (criteria.length === 0 || names.length === 0)
    return [
      ...(criteria.length === 0 ? ["no acceptance criteria found in the spec"] : []),
      ...(names.length === 0 ? ["no acceptance tests found"] : []),
    ];

  const problems: string[] = [];
  const families = [...new Set(ids.map(familyOf))];

  for (const id of ids) if (!WHOLE.test(id)) problems.push(`${id} is not a family and a whole number`);
  for (const family of families) {
    const members = ids.filter((id) => familyOf(id) === family && WHOLE.test(id));
    const expected = members.map((_, index) => `${family}-${index + 1}`);
    if (members.join() !== expected.join())
      problems.push(`${family} is numbered ${members.join(", ")} instead of from 1 without gaps`);
  }

  const cited = new Set<string>();
  for (const line of spec.match(CRITERION_LINE) ?? []) {
    const criterion = captures(line, DEFINITION)[0] ?? line;
    const citations = CITATION_LIST.exec(line)?.[1]?.split(", ") ?? [];
    if (citations.length === 0) problems.push(`${criterion} cites no requirement`);
    for (const citation of citations) {
      cited.add(citation);
      if (!ids.includes(citation)) problems.push(`${criterion} cites ${citation}, which the spec does not define`);
    }
  }
  for (const id of ids)
    if (!UNCITED_FAMILIES.includes(familyOf(id)) && !cited.has(id)) problems.push(`${id} is cited by no criterion`);

  const mention = new RegExp(`\\b((?:${families.join("|")})-\\d+[a-z]?)\\b`, "g");
  for (const id of new Set(captures(spec, mention)))
    if (!ids.includes(id) && !cited.has(id)) problems.push(`${id} is mentioned but not defined`);

  const tested = new Set<string>();
  for (const name of names) {
    const proves = CITED_CRITERIA.exec(name)?.[1]?.trim().split(" ") ?? [];
    if (proves.length === 0) problems.push(`acceptance test "${name}" cites no criterion`);
    for (const criterion of proves) {
      tested.add(criterion);
      if (!criteria.includes(criterion))
        problems.push(`acceptance test "${name}" cites ${criterion}, which the spec does not define`);
    }
  }
  for (const criterion of criteria)
    if (!tested.has(criterion)) problems.push(`${criterion} has no acceptance test or todo`);

  return problems;
}
