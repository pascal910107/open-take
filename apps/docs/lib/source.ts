import { docs } from "@/.source/server";
import { type InferPageType, loader } from "fumadocs-core/source";

export const source = loader({
  baseUrl: "/docs",
  source: docs.toFumadocsSource(),
});

export async function getLLMText(page: InferPageType<typeof source>): Promise<string> {
  const body =
    (page.data as { processedMarkdown?: string }).processedMarkdown ?? page.data.description ?? "";
  return `# ${page.data.title}\nURL: ${page.url}\n\n${body}`;
}
