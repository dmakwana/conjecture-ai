/**
 * A fixture seeded with realistic PII. The redaction test asserts that none of
 * these literals survive into the profile, so they must look like real values.
 */
/** Non-ASCII names. The original mask was ASCII-only, so these went through
 *  it untouched and were transmitted verbatim. */
export const NON_ASCII_LITERALS = [
  "田中太郎", "Иван Петров", "Zoé Müller", "مرحبا", "Ελλάδα", "李明",
];

export const PII_LITERALS = [
  "aaron.blake@acme.io",
  "zoe.k@example.org",
  "priya.raman@northwind.co.uk",
  "Aaron Blake",
  "Zoe Kaur",
  "Priya Raman",
  "123-45-6789",
  "987-65-4321",
  "555-01-0199",
  "ACCT-99381",
];

export const CSV_FIXTURE = `id,email,full_name,ssn,amount,created_at,active,notes
1,aaron.blake@acme.io,Aaron Blake,123-45-6789,10.50,2024-03-01,true,ok
2,zoe.k@example.org,Zoe Kaur,987-65-4321,-3.25,1970-01-01,false,
3,priya.raman@northwind.co.uk,Priya Raman,555-01-0199,0,2099-12-31,true,  padded  
4,aaron.blake@acme.io,Aaron Blake,123-45-6789,42.00,2024-05-17,true,ACCT-99381
5,,Sam Fox,,7.75,2024-06-02,false,fine
6,mixed.CASE@acme.io,sam fox,111-22-3333,3.10,2024-07-04,true,   
7,tanaka@example.jp,田中太郎,222-33-4444,5.00,2024-08-01,true,ok
8,ivan@example.ru,Иван Петров,333-44-5555,6.00,2024-08-02,false,ok
9,zoe@example.fr,Zoé Müller,444-55-6666,7.00,2024-08-03,true,ok
`;

/** Data rows in CSV_FIXTURE, derived so tests do not hardcode a count that
 *  drifts every time a row is added. */
export const CSV_FIXTURE_ROWS =
  CSV_FIXTURE.trim().split("\n").length - 1;
