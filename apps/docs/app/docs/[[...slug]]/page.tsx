import { getMDXComponents } from "@/components/mdx";
import { source } from "@/lib/source";
import { getBreadcrumbItems } from "fumadocs-core/breadcrumb";
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from "fumadocs-ui/layouts/docs/page";
import { createRelativeLink } from "fumadocs-ui/mdx";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

const ORIGIN = "https://open-take.dev";

interface PageParams {
  params: Promise<{ slug?: string[] }>;
}

const text = (node: ReactNode) => (typeof node === "string" ? node : String(node));

/** The trail as the sidebar shows it — Docs › CLI › render — as an absolute-url
 *  BreadcrumbList, which is what Google renders in place of the raw URL. */
function breadcrumbList(url: string) {
  const tree = source.getPageTree();
  const trail = getBreadcrumbItems(url, tree, { includePage: true });
  // fumadocs only emits a root entry for a folder marked `root`, and this tree
  // has none — so the docs home is prepended by hand, except on the home itself
  const items =
    trail[0]?.url === "/docs" ? trail : [{ name: text(tree.name), url: "/docs" }, ...trail];

  return {
    "@type": "BreadcrumbList",
    "@id": `${ORIGIN}${url}#breadcrumb`,
    itemListElement: items.map((item, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: text(item.name),
      ...(item.url ? { item: `${ORIGIN}${item.url}` } : {}),
    })),
  };
}

export default async function Page(props: PageParams) {
  const { slug } = await props.params;
  const page = source.getPage(slug);
  if (!page) notFound();

  const MDX = page.data.body;
  // self-contained per page: the organization node is repeated rather than
  // referenced across pages, because crawlers evaluate one page at a time
  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": `${ORIGIN}/#project`,
        name: "open-take",
        url: `${ORIGIN}/`,
        logo: `${ORIGIN}/icon-512.png`,
        sameAs: [
          "https://github.com/pascal910107/open-take",
          "https://www.npmjs.com/package/open-take",
        ],
      },
      {
        "@type": "TechArticle",
        "@id": `${ORIGIN}${page.url}#article`,
        headline: page.data.title,
        name: page.data.title,
        description: page.data.description,
        url: `${ORIGIN}${page.url}`,
        inLanguage: "en",
        isPartOf: { "@type": "WebSite", "@id": `${ORIGIN}/#website` },
        about: { "@type": "SoftwareApplication", "@id": `${ORIGIN}/#software`, name: "open-take" },
        author: { "@id": `${ORIGIN}/#project` },
        publisher: { "@id": `${ORIGIN}/#project` },
        breadcrumb: { "@id": `${ORIGIN}${page.url}#breadcrumb` },
      },
      breadcrumbList(page.url),
    ],
  };

  return (
    <DocsPage toc={page.data.toc} full={page.data.full}>
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: the only way to emit a ld+json script — the values are our own build-time content, and < is escaped so no string can close the tag
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }}
      />
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription>{page.data.description}</DocsDescription>
      <DocsBody>
        <MDX components={getMDXComponents({ a: createRelativeLink(source, page) })} />
      </DocsBody>
    </DocsPage>
  );
}

export function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata(props: PageParams): Promise<Metadata> {
  const { slug } = await props.params;
  const page = source.getPage(slug);
  if (!page) notFound();

  const { title, description } = page.data;
  // Next replaces the layout's openGraph wholesale rather than merging into it,
  // so the shared parts (site name, card image) are restated here or they are
  // simply absent from every docs page
  const shared = `${title} — open-take docs`;

  return {
    title,
    description,
    // this app answers on its own *.vercel.app host too; the canonical names
    // the open-take.dev URL as the one worth indexing, whoever served the page
    alternates: { canonical: page.url },
    openGraph: {
      type: "article",
      siteName: "open-take docs",
      locale: "en_US",
      url: page.url,
      title: shared,
      description,
      images: [{ url: "/og.jpg", width: 1200, height: 630, alt: "open-take documentation" }],
    },
    twitter: {
      card: "summary_large_image",
      title: shared,
      description,
      images: ["/og.jpg"],
    },
  };
}
