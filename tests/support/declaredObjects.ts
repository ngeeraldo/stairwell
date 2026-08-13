// tests/support/declaredObjects.ts
//
// Shared by tests/users/conventions.test.ts and tests/scripts/newDashboard.test.ts
// — both need to read the table/view names a schema.sql declares, one against
// a committed user folder, the other against a freshly scaffolded one.

/**
 * Table and view names declared in a schema file. Strips `--` line comments
 * first, so a retired table documented in a comment (e.g. "-- CREATE TABLE
 * old_thing (...)") is not read as a live declaration. SQL block comments are
 * left alone — no schema.sql in this repo uses them, so handling them is not
 * worth the added complexity.
 */
export function declaredObjects(sql: string): string[] {
  const withoutLineComments = sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
  const names: string[] = []
  const re = /CREATE\s+(?:TABLE|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?([A-Za-z_][A-Za-z0-9_]*)/gi
  let match: RegExpExecArray | null
  while ((match = re.exec(withoutLineComments)) !== null) names.push(match[1]!)
  return names
}
