// Genera las notas de un release agrupando los PRs mergeados por tipo
// (prefijo de commit convencional en el título del PR).
// Uso: bun scripts/release-notes.ts <tag> <repo> <sha256> [tag-previo]
import { $ } from "bun";

const sections: [string, string[]][] = [
  ["✨ Novedades", ["feat"]],
  ["🐛 Correcciones", ["fix"]],
  ["⚡ Rendimiento", ["perf"]],
  ["📚 Documentación", ["docs"]],
  ["🧪 Pruebas", ["test"]],
  ["🔧 CI y build", ["ci", "build", "publish"]],
  ["🧹 Mantenimiento", ["chore", "refactor", "style"]],
];

export type Change = { title: string; pr?: number };

// Los merge commits no traen el título del PR, así que se consulta con gh.
const prTitle = async (pr: number, repo: string): Promise<string> =>
  (await $`gh pr view ${pr} --repo ${repo} --json title --jq .title`.nothrow().text()).trim();

export const parseChanges = (log: string): Change[] =>
  log
    .split("\x1e")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .flatMap((entry) => {
      const [subject = "", ...body] = entry.split("\n");
      const pr = subject.match(/^Merge pull request #(\d+)/)?.[1] ?? subject.match(/\(#(\d+)\)$/)?.[1];
      const title = (subject.startsWith("Merge pull request") ? body.join(" ") : subject.replace(/\s*\(#\d+\)$/, "")).trim();
      if (/^release: v/.test(title)) return [];
      return [{ title: title || `Merge pull request #${pr}`, pr: pr ? Number(pr) : undefined }];
    });

export const renderChanges = (changes: Change[], repo: string): string => {
  const used = new Set<Change>();
  const out: string[] = [];
  const line = ({ title, pr }: Change) =>
    `- ${title.replace(/^\w+(\([^)]*\))?!?:\s*/, "")}${pr ? ` ([#${pr}](https://github.com/${repo}/pull/${pr}))` : ""}`;
  const typeOf = (c: Change) => c.title.match(/^(\w+)(\([^)]*\))?!?:/)?.[1]?.toLowerCase();
  for (const [heading, types] of sections) {
    const items = changes.filter((c) => types.includes(typeOf(c) ?? ""));
    if (!items.length) continue;
    items.forEach((c) => used.add(c));
    out.push(`### ${heading}`, "", ...items.map(line), "");
  }
  const rest = changes.filter((c) => !used.has(c));
  if (rest.length) out.push("### 📦 Otros cambios", "", ...rest.map((c) => `- ${c.title}${c.pr ? ` ([#${c.pr}](https://github.com/${repo}/pull/${c.pr}))` : ""}`), "");
  return out.length ? out.join("\n") : "_Sin cambios visibles desde el release anterior._\n";
};

if (import.meta.main) {
  const [tag, repo, sha, prevArg] = process.argv.slice(2);
  if (!tag || !repo || !sha) throw new Error("uso: release-notes.ts <tag> <repo> <sha256> [tag-previo]");
  const version = tag.replace(/^v/, "");
  const prev = prevArg || (await $`git describe --tags --abbrev=0 ${tag}^`.nothrow().text()).trim();
  const range = prev ? `${prev}..${tag}` : tag;
  const log = await $`git log --first-parent --format=%s%n%b%x1e ${range}`.text();
  const parsed = parseChanges(log);
  for (const c of parsed) {
    if (c.pr) c.title = (await prTitle(c.pr, repo)) || c.title;
  }
  const changes = renderChanges(parsed.filter((c) => !/^release: v/.test(c.title)), repo);
  const asset = `https://github.com/${repo}/releases/download/${tag}/donly-proxy.js`;
  const notes = `## Cambios en ${tag}

${changes}
${prev ? `**Comparación completa**: https://github.com/${repo}/compare/${prev}...${tag}\n` : ""}
## Instalación

\`\`\`sh
mkdir -p ~/donly-proxy/bin
curl -fsSL ${asset} -o ~/donly-proxy/bin/donly-proxy.js
bun ~/donly-proxy/bin/donly-proxy.js
\`\`\`

## SHA256

\`\`\`
${sha}  donly-proxy.js
\`\`\`

<details>
<summary>Fórmula de Homebrew (template)</summary>

\`\`\`ruby
class DonlyProxy < Formula
  desc "Proxy for donly: continuation of the demo proxy"
  homepage "https://github.com/${repo}"
  version "${version}"
  url "${asset}"
  sha256 "${sha}"
  license "MIT"

  depends_on "oven-sh/bun/bun"

  def install
    libexec.install "donly-proxy.js"
    (bin/"donly-proxy").write <<~EOS
      #!/bin/sh
      exec bun "#{libexec}/donly-proxy.js" "$@"
    EOS
  end

  test do
    assert_predicate libexec/"donly-proxy.js", :exist?
  end
end
\`\`\`

</details>
`;
  console.log(notes);
}
