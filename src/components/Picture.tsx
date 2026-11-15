import { useQuery } from "@tanstack/react-query";
import { createContext, useContext, useState } from "react";

/** Where pictures that need a sign-in load from: the screen's Git host or tracker, through the app. `key` tells apart
 * two screens' pictures of the same name (Jira attachments go by name). */
export const PictureSource = createContext<{ key: string; load: (src: string) => Promise<string>; hidden?: boolean } | null>(null);

/** A picture from the web: an https one loads straight, with no referrer. One that fails (a private repository's, an
 * Azure DevOps attachment), a relative link (GitLab and Gitea uploads) or a Jira attachment's name then loads through
 * the app with the sign-in, where the screen gives a `PictureSource`. Else its alt text shows. A `hidden` source
 * keeps every picture as its alt text until the project allows them. */
export function Picture({ src, alt, ...rest }: { src: string; alt?: string; [attr: string]: unknown }) {
  const source = useContext(PictureSource);
  const direct = /^https:\/\//i.test(src);
  const [failed, setFailed] = useState(false);
  const viaApp = !!source && !source.hidden && (!direct || failed);
  const q = useQuery({
    queryKey: ["picture", source?.key, src],
    queryFn: () => source!.load(src),
    enabled: viaApp,
    staleTime: Infinity,
    retry: false,
  });
  if (viaApp && q.data) return <img {...rest} alt={alt} src={q.data} />;
  if (viaApp || !direct || source?.hidden) return <>{alt || null}</>;
  return <img {...rest} alt={alt} src={src} referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
}
