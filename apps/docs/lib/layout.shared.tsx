import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <>
          <span
            aria-hidden
            style={{
              width: 9,
              height: 9,
              borderRadius: "50%",
              background: "#6e6ef7",
              boxShadow: "0 0 10px rgba(110,110,247,0.9)",
            }}
          />
          open-take
        </>
      ),
    },
    githubUrl: "https://github.com/pascal910107/open-take",
  };
}
