export const withUtm = (link: string) => {
  const url = new URL(link);
  url.searchParams.append("utm_content", "agents.cloudflare.com");
  return url.toString();
};

export const AGENTS_DOCS_HREF = withUtm(
  "https://developers.cloudflare.com/agents/"
);

export const AGENTS_DOCS_GET_STARTED_HREF = withUtm(
  "https://developers.cloudflare.com/agents/#get-started"
);
