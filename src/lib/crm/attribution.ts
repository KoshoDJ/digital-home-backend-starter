/**
 * Content→lead attribution: which pages the visitors who became leads
 * actually read. Sourced from the visitors table (lead_id set once a visitor
 * converts, pages_viewed accumulated per visitor). Feeds the agents'
 * get_content_attribution tool and biases trend-scan toward what converts.
 */
import type { AdminClient } from "./types";

export interface PageAttribution {
  page: string;
  converted_visitors: number; // visitors on this page who became leads
  total_visitors: number; // all visitors who viewed this page
}

export interface AttributionSummary {
  linked_visitors: number;
  pages: PageAttribution[];
}

export async function getContentAttribution(
  supabase: AdminClient,
  limit = 15
): Promise<AttributionSummary> {
  const { data: visitors, error } = await supabase
    .from("visitors")
    .select("lead_id, pages_viewed")
    .limit(10000);
  if (error || !visitors?.length) return { linked_visitors: 0, pages: [] };

  const totals = new Map<string, { converted: number; total: number }>();
  let linked = 0;
  for (const v of visitors) {
    const isLead = !!v.lead_id;
    if (isLead) linked++;
    const pages = Array.isArray(v.pages_viewed) ? v.pages_viewed : [];
    for (const page of new Set(pages.map(String))) {
      const entry = totals.get(page) || { converted: 0, total: 0 };
      entry.total++;
      if (isLead) entry.converted++;
      totals.set(page, entry);
    }
  }

  const pages = Array.from(totals.entries())
    .map(([page, t]) => ({ page, converted_visitors: t.converted, total_visitors: t.total }))
    .sort((a, b) => b.converted_visitors - a.converted_visitors || b.total_visitors - a.total_visitors)
    .slice(0, limit);

  return { linked_visitors: linked, pages };
}

/** One prompt-ready block for trend-scan; empty string when there's no signal. */
export async function attributionPromptBlock(supabase: AdminClient): Promise<string> {
  const { linked_visitors, pages } = await getContentAttribution(supabase, 8);
  const converting = pages.filter((p) => p.converted_visitors > 0);
  if (!converting.length) return "";
  return (
    `\nContent that has already attracted leads (${linked_visitors} converted visitors — prefer topics adjacent to these):\n` +
    converting.map((p) => `- ${p.page} (${p.converted_visitors} converted / ${p.total_visitors} viewed)`).join("\n")
  );
}
