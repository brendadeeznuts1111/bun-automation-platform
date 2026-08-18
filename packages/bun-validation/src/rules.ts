import { loadConfig } from "./config.ts";
import {
  isPipelineExtracted,
  isPipelineNormalized,
  readSchemaVersion,
} from "./guards.ts";
import type {
  ExtractedData,
  ExtractedRelease,
  NormalizedBlock,
  NormalizedFeature,
  Rule,
  RuleContext,
  ValidationIssue,
  Severity,
  ValidatorConfig,
} from "./types.ts";

function issue(
  rule: string,
  message: string,
  severity: Severity = "error",
): ValidationIssue {
  return { rule, message, severity, category: "semantic" };
}

function statusKey(status: string): string {
  return status.trim().toLowerCase();
}

const emptyHeadingRule: Rule = {
  id: "empty-heading",
  description: "Headings / feature names must be non-empty",
  run(ctx) {
    const out: ValidationIssue[] = [];
    if (isPipelineExtracted(ctx.extracted)) {
      ctx.extracted.code_blocks.forEach((b, i) => {
        if (!b.feature.trim()) out.push(issue(this.id, `Block ${i}: empty feature`));
      });
      return out;
    }
    ctx.extracted.sections.forEach((s, i) => {
      if (!s.heading.trim()) out.push(issue(this.id, `Section ${i}: empty heading`));
    });
    return out;
  },
};

const emptyCodeRule: Rule = {
  id: "empty-code",
  description: "Empty code: error in document schema; warning in pipeline (prose-only features OK)",
  run(ctx) {
    const out: ValidationIssue[] = [];
    if (isPipelineExtracted(ctx.extracted)) {
      ctx.extracted.code_blocks.forEach((b, i) => {
        if (b.code.trim()) return;
        const severity: Severity = ctx.schemaVersion === "2" ? "error" : "warning";
        out.push(issue(this.id, `Block ${i} (${b.feature}): empty code`, severity));
      });
      return out;
    }
    ctx.extracted.sections.forEach((s, i) => {
      s.codeBlocks.forEach((b, j) => {
        if (!b.code.trim()) {
          const severity: Severity = ctx.schemaVersion === "2" ? "error" : "warning";
          out.push(issue(this.id, `Section ${i} (${s.heading}), block ${j}: empty code`, severity));
        }
      });
    });
    return out;
  },
};

const missingFieldsRule: Rule = {
  id: "missing-fields",
  description: "Warn on empty purpose/notes; document features need a code block",
  run(ctx) {
    const out: ValidationIssue[] = [];
    if (isPipelineExtracted(ctx.extracted)) {
      ctx.extracted.code_blocks.forEach((b, i) => {
        if (!b.purpose.trim()) {
          out.push(issue(this.id, `Block ${i} (${b.feature}): empty purpose`, "warning"));
        }
        if (!b.notes.trim()) {
          out.push(issue(this.id, `Block ${i} (${b.feature}): empty notes`, "warning"));
        }
      });
    }
    if (!isPipelineNormalized(ctx.normalized)) {
      ctx.normalized.forEach((item, i) => {
        if (item.codeBlocks.length === 0) {
          out.push(
            issue(this.id, `Normalized ${i} (${item.heading}): expected at least one code block`, "warning"),
          );
        }
      });
    }
    return out;
  },
};

const unknownLanguageRule: Rule = {
  id: "unknown-language",
  description: "Code languages should be from the known set (warning)",
  run(ctx) {
    const out: ValidationIssue[] = [];
    const langs = ctx.config.validLangs;
    const check = (lang: string, where: string) => {
      const key = lang.trim().toLowerCase();
      if (!key || langs.has(key)) return;
      out.push(issue(this.id, `${where}: unknown language '${lang}'`, "warning"));
    };
    if (isPipelineExtracted(ctx.extracted)) {
      ctx.extracted.code_blocks.forEach((b, i) => {
        if (b.lang !== undefined) check(b.lang, `Block ${i} (${b.feature})`);
      });
      return out;
    }
    ctx.extracted.sections.forEach((s, i) => {
      s.codeBlocks.forEach((b, j) => {
        check(b.lang, `Section ${i} (${s.heading}), block ${j}`);
      });
    });
    return out;
  },
};

const statusCasingRule: Rule = {
  id: "status-casing",
  description: "Status should use a preferred exact spelling when known",
  run(ctx) {
    const out: ValidationIssue[] = [];
    const preferred = ctx.config.preferredStatusForms;
    const allowed = ctx.config.validStatuses;
    const check = (status: string, where: string) => {
      const key = statusKey(status);
      if (!allowed.has(key)) {
        out.push(issue(this.id, `${where}: unknown status '${status}'`, "warning"));
        return;
      }
      if (!preferred.has(status)) {
        const hint = [...preferred].filter((p) => statusKey(p) === key).join(", ") || key;
        out.push(
          issue(
            this.id,
            `${where}: status '${status}' casing is non-preferred (use one of: ${hint})`,
            ctx.schemaVersion === "2" ? "error" : "warning",
          ),
        );
      }
    };
    if (isPipelineExtracted(ctx.extracted)) {
      ctx.extracted.code_blocks.forEach((b, i) => check(b.status, `Block ${i} (${b.feature})`));
    }
    if (isPipelineNormalized(ctx.normalized)) {
      ctx.normalized.forEach((item, i) => check(item.status, `Normalized ${i} (${item.feature})`));
    } else {
      ctx.normalized.forEach((item, i) => check(item.status, `Normalized ${i} (${item.heading})`));
    }
    return out;
  },
};

const normalizedHeadingRule: Rule = {
  id: "normalized-heading",
  description: "Each normalized item must exist in extracted",
  run(ctx) {
    const names = isPipelineExtracted(ctx.extracted)
      ? new Set(ctx.extracted.code_blocks.map((b) => b.feature))
      : new Set(ctx.extracted.sections.map((s) => s.heading));
    const out: ValidationIssue[] = [];
    if (isPipelineNormalized(ctx.normalized)) {
      ctx.normalized.forEach((item, i) => {
        if (!names.has(item.feature)) {
          out.push(
            issue(this.id, `Normalized item ${i} feature '${item.feature}' not found in extracted`),
          );
        }
      });
      return out;
    }
    ctx.normalized.forEach((item, i) => {
      if (!names.has(item.heading)) {
        out.push(
          issue(this.id, `Normalized item ${i} heading '${item.heading}' not found in extracted`),
        );
      }
    });
    return out;
  },
};

const statusReadinessRule: Rule = {
  id: "status-readiness",
  description: "Stable items must be production-ready; highly experimental must not",
  run(ctx) {
    const out: ValidationIssue[] = [];
    if (isPipelineNormalized(ctx.normalized)) {
      ctx.normalized.forEach((item, i) => {
        if (item.productionReady === undefined) return;
        const status = statusKey(item.status);
        if (status === "stable" && !item.productionReady) {
          out.push(
            issue(this.id, `Normalized ${i} (${item.feature}): Stable but productionReady false`),
          );
        }
        if (status === "highly experimental" && item.productionReady) {
          out.push(
            issue(
              this.id,
              `Normalized ${i} (${item.feature}): Highly Experimental but productionReady true`,
            ),
          );
        }
      });
      return out;
    }
    ctx.normalized.forEach((item, i) => {
      const status = statusKey(item.status);
      if (status === "stable" && !item.productionReady) {
        out.push(
          issue(this.id, `Normalized ${i} (${item.heading}): Stable but productionReady false`),
        );
      }
      if (status === "highly experimental" && item.productionReady) {
        out.push(
          issue(
            this.id,
            `Normalized ${i} (${item.heading}): Highly Experimental but productionReady true`,
          ),
        );
      }
      if (status === "stable" && !item.apiSignature?.trim()) {
        out.push(
          issue(this.id, `Normalized ${i} (${item.heading}): Stable but missing apiSignature`, "warning"),
        );
      }
    });
    return out;
  },
};

const duplicateHeadingRule: Rule = {
  id: "duplicate-heading",
  description: "Extracted headings / features must be unique",
  run(ctx) {
    const seen = new Set<string>();
    const out: ValidationIssue[] = [];
    if (isPipelineExtracted(ctx.extracted)) {
      ctx.extracted.code_blocks.forEach((b, i) => {
        if (seen.has(b.feature)) {
          out.push(issue(this.id, `Duplicate feature: '${b.feature}' at block ${i}`));
        }
        seen.add(b.feature);
      });
      return out;
    }
    ctx.extracted.sections.forEach((s, i) => {
      if (seen.has(s.heading)) {
        out.push(issue(this.id, `Duplicate heading: '${s.heading}' at section ${i}`));
      }
      seen.add(s.heading);
    });
    return out;
  },
};

const statusMatchRule: Rule = {
  id: "status-match",
  description: "Extracted and normalized status must match for the same feature",
  run(ctx) {
    if (!isPipelineExtracted(ctx.extracted) || !isPipelineNormalized(ctx.normalized)) return [];
    const byFeature = new Map(ctx.extracted.code_blocks.map((b) => [b.feature, b]));
    const out: ValidationIssue[] = [];
    ctx.normalized.forEach((item, i) => {
      const src = byFeature.get(item.feature);
      if (src && statusKey(src.status) !== statusKey(item.status)) {
        out.push(
          issue(
            this.id,
            `Normalized ${i} (${item.feature}): status '${item.status}' != extracted '${src.status}'`,
          ),
        );
      }
    });
    return out;
  },
};

const uniqueIdRule: Rule = {
  id: "unique-id",
  description: "Normalized IDs must be unique",
  run(ctx) {
    if (!isPipelineNormalized(ctx.normalized)) return [];
    const seen = new Set<string>();
    const out: ValidationIssue[] = [];
    ctx.normalized.forEach((item, i) => {
      if (seen.has(item.id)) {
        out.push(issue(this.id, `Duplicate normalized id '${item.id}' at item ${i}`));
      }
      seen.add(item.id);
    });
    return out;
  },
};

const addedInRule: Rule = {
  id: "added-in",
  description: "normalized.added_in must match the release version",
  run(ctx) {
    if (!isPipelineNormalized(ctx.normalized)) return [];
    const out: ValidationIssue[] = [];
    ctx.normalized.forEach((item, i) => {
      if (item.added_in !== ctx.version) {
        out.push(
          issue(
            this.id,
            `Normalized ${i} (${item.feature}): added_in '${item.added_in}' != version '${ctx.version}'`,
            "warning",
          ),
        );
      }
    });
    return out;
  },
};

const markdownLinkRule: Rule = {
  id: "markdown-links",
  description: "URLs and markdown links in headings/notes must be parseable",
  run(ctx) {
    const out: ValidationIssue[] = [];
    const check = (text: string, where: string) => {
      for (const href of extractHrefs(text)) {
        if (href.startsWith("#") || href.startsWith("/")) continue;
        if (!URL.canParse(href)) {
          out.push(issue(this.id, `${where}: invalid link '${href}'`, "warning"));
        }
      }
    };
    if (isPipelineExtracted(ctx.extracted)) {
      ctx.extracted.code_blocks.forEach((b, i) => {
        check(b.feature, `Block ${i} feature`);
        check(b.notes, `Block ${i} (${b.feature}) notes`);
        check(b.purpose, `Block ${i} (${b.feature}) purpose`);
      });
    } else {
      ctx.extracted.sections.forEach((s, i) => {
        check(s.heading, `Section ${i} heading`);
        if (s.text) check(s.text, `Section ${i} (${s.heading}) text`);
      });
    }
    return out;
  },
};

export function extractHrefs(text: string): string[] {
  const md = /\[([^\]]*)\]\(([^)]+)\)/g;
  const bare = /https?:\/\/[^\s)\]>'"]+/g;
  const found = new Set<string>();
  for (const match of text.matchAll(md)) {
    const href = match[2];
    if (href) found.add(href);
  }
  const stripped = text.replace(/\[([^\]]*)\]\(([^)]+)\)/g, " ");
  for (const match of stripped.matchAll(bare)) {
    if (match[0]) found.add(match[0]);
  }
  return [...found];
}

const releaseFieldRule: Rule = {
  id: "release-field",
  description: "extracted.release must match bun-v<version>",
  run(ctx) {
    if (!isPipelineExtracted(ctx.extracted)) return [];
    const expected = `bun-v${ctx.version}`;
    if (ctx.extracted.release !== expected) {
      return [issue(this.id, `extracted.release '${ctx.extracted.release}' != '${expected}'`)];
    }
    return [];
  },
};

/** Extensible rule list — add new rules here. */
export const RULES: Rule[] = [
  emptyHeadingRule,
  emptyCodeRule,
  missingFieldsRule,
  unknownLanguageRule,
  statusCasingRule,
  normalizedHeadingRule,
  statusReadinessRule,
  duplicateHeadingRule,
  statusMatchRule,
  uniqueIdRule,
  addedInRule,
  markdownLinkRule,
  releaseFieldRule,
];

export function resolveSchemaVersion(extracted: ExtractedRelease | ExtractedData) {
  return readSchemaVersion(extracted);
}

export function collectIssues(
  extracted: ExtractedRelease | ExtractedData,
  normalized: NormalizedBlock[] | NormalizedFeature[],
  version = "",
  config: RuleContext["config"] = loadConfig(),
): ValidationIssue[] {
  const ctx: RuleContext = {
    version,
    schemaVersion: resolveSchemaVersion(extracted),
    extracted,
    normalized,
    config,
  };
  const out: ValidationIssue[] = [];
  for (const rule of RULES) {
    out.push(...rule.run(ctx));
    const errorCount = out.filter((i) => i.severity === "error").length;
    if (config.maxErrors > 0 && errorCount >= config.maxErrors) {
      out.push(
        issue("max-errors", `Error count ${errorCount} reached MAX_ERRORS=${config.maxErrors}`),
      );
      break;
    }
  }
  return out;
}

export function validateSemantics(
  extracted: ExtractedRelease | ExtractedData,
  normalized: NormalizedBlock[] | NormalizedFeature[],
  version = "",
  config?: ValidatorConfig,
): string[] {
  return collectIssues(extracted, normalized, version, config ?? loadConfig())
    .filter((i) => i.severity === "error")
    .map((i) => i.message);
}

export function validateSemanticWarnings(
  extracted: ExtractedRelease | ExtractedData,
  normalized: NormalizedBlock[] | NormalizedFeature[],
  version = "",
  config?: ValidatorConfig,
): string[] {
  return collectIssues(extracted, normalized, version, config ?? loadConfig())
    .filter((i) => i.severity === "warning")
    .map((i) => i.message);
}
