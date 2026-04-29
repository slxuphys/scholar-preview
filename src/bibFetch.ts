// ---------------------------------------------------------------------------
// Bibliography fetch helpers — run in extension host, no CORS restrictions.
// ---------------------------------------------------------------------------
import * as https from "https";
import * as http from "http";

export interface BibEntry {
  /** Short display string: "Author1, Author2. "Title."" */
  cite: string;
  /** Link label: e.g. "Phys. Rev. X 8, 021013 (2018)" or "arXiv:2604.24784 (2025)" */
  linkLabel: string;
  /** Full BibTeX entry string for writing to refs.bib */
  bibtex: string;
}

/** Sanitise a DOI into a valid BibTeX / Typst cite key. */
export function bibKeyForDoi(doi: string): string {
  return "doi_" + doi.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** Sanitise an arXiv ID into a valid BibTeX / Typst cite key. */
export function bibKeyForArxiv(id: string): string {
  return "arxiv_" + id.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** Fetch a remote URL as a raw Buffer (follows redirects). Handles both http and https. */
export function httpsGetBuffer(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const mod: typeof https = url.startsWith("http://") ? (http as unknown as typeof https) : https;
    mod.get(url, { headers: { "User-Agent": "vscode-notebook-preview/1.0" } }, (res: http.IncomingMessage) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve(httpsGetBuffer(res.headers.location));
        return;
      }
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    }).on("error", reject);
  });
}

export function httpsGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "vscode-notebook-preview/1.0" } }, (res: http.IncomingMessage) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve(httpsGet(res.headers.location));
        return;
      }
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      res.on("error", reject);
    }).on("error", reject);
  });
}

export async function fetchDoiBib(doi: string): Promise<BibEntry> {
  const url = `https://api.crossref.org/works/${encodeURIComponent(doi)}`;
  const body = await httpsGet(url);
  const data = JSON.parse(body) as { message: Record<string, unknown> };
  const w = data.message;

  const title = ((w.title as string[] | undefined)?.[0]) ?? "Untitled";
  const rawAuthors = (w.author as Array<{ family?: string; given?: string; name?: string }> | undefined) ?? [];

  const authorsDisplay = rawAuthors.slice(0, 4).map(a =>
    a.family ? (a.given ? `${a.given} ${a.family}` : a.family) : (a.name ?? "?")
  );
  if (rawAuthors.length > 4) { authorsDisplay.push("et al."); }

  // BibTeX format: "Last, First and Last2, First2"
  const authorsBib = rawAuthors.map(a =>
    a.family ? (a.given ? `${a.family}, ${a.given}` : a.family) : (a.name ?? "?")
  ).join(" and ");

  const dateParts =
    (w.published as { "date-parts"?: number[][] } | undefined)?.["date-parts"] ??
    (w["published-print"] as { "date-parts"?: number[][] } | undefined)?.["date-parts"] ??
    (w["published-online"] as { "date-parts"?: number[][] } | undefined)?.["date-parts"];
  const year = String(dateParts?.[0]?.[0] ?? "");
  const journal = ((w["container-title"] as string[] | undefined)?.[0]) ?? "";
  const volume = (w.volume as string | undefined) ?? "";
  const pages = (w.page as string | undefined) ?? "";

  const cite = (authorsDisplay.length > 0 ? `${authorsDisplay.join(", ")}. ` : "") + `\u201c${title}.\u201d`;
  let linkLabel = journal;
  if (volume) { linkLabel += ` ${volume}`; }
  if (pages) { linkLabel += `, ${pages}`; }
  if (year) { linkLabel += ` (${year})`; }
  if (!linkLabel.trim()) { linkLabel = `doi:${doi}`; }

  const key = bibKeyForDoi(doi);
  const fields: string[] = [`  author = {${authorsBib}}`, `  title  = {${title}}`];
  if (journal) { fields.push(`  journal = {${journal}}`); }
  if (volume)  { fields.push(`  volume  = {${volume}}`); }
  if (pages)   { fields.push(`  pages   = {${pages}}`); }
  if (year)    { fields.push(`  year    = {${year}}`); }
  fields.push(`  doi     = {${doi}}`);
  fields.push(`  url     = {https://doi.org/${doi}}`);
  const bibtex = `@article{${key},\n${fields.join(",\n")}\n}`;

  return { cite: cite.trim(), linkLabel: linkLabel.trim(), bibtex };
}

export async function fetchArxivBib(id: string): Promise<BibEntry> {
  const url = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`;
  const xml = await httpsGet(url);

  const entryStart = xml.indexOf("<entry");
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(xml.slice(entryStart));
  const title = (titleMatch?.[1] ?? "Untitled").trim().replace(/\s+/g, " ");

  const authorMatches = [...xml.matchAll(/<name>([\s\S]*?)<\/name>/g)];
  const authorNames = authorMatches.map(m => m[1].trim());
  const authorsDisplay = authorNames.slice(0, 4);
  if (authorNames.length > 4) { authorsDisplay.push("et al."); }

  const publishedMatch = /<published>([\s\S]*?)<\/published>/i.exec(xml);
  const year = publishedMatch?.[1]?.trim().slice(0, 4) ?? "";

  const cite = (authorsDisplay.length > 0 ? `${authorsDisplay.join(", ")}. ` : "") + `\u201c${title}.\u201d`;
  const linkLabel = year ? `arXiv:${id} (${year})` : `arXiv:${id}`;

  const key = bibKeyForArxiv(id);
  const fields: string[] = [
    `  author = {${authorNames.join(" and ")}}`,
    `  title  = {${title}}`,
  ];
  if (year) { fields.push(`  year   = {${year}}`); }
  fields.push(`  note   = {arXiv:${id}}`);
  fields.push(`  url    = {https://arxiv.org/abs/${id}}`);
  const bibtex = `@article{${key},\n${fields.join(",\n")}\n}`;

  return { cite: cite.trim(), linkLabel, bibtex };
}
