// About: the guide, the changes, credits and the licence, bundled with the
// app (no network). Main view: the chosen document. Panel: the documents and
// each one's chapters (a click jumps to it).
import { BookOpen, History, Scale } from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import guide from "../../../docs/GUIDE.md?raw";
import changelog from "../../../CHANGELOG.md?raw";
import credits from "../../../docs/CREDITS.md?raw";
import { Accordion, Section } from "../panel/Section";
import { SplitView } from "../panel/SplitView";
import { usePref } from "../prefs";
import { versionText } from "./SettingsPage";

const DOCS = {
  guide: { title: "Guide", icon: BookOpen, text: guide },
  changes: { title: "Changes", icon: History, text: changelog },
  credits: { title: "Credits & licence", icon: Scale, text: credits },
} as const;
type DocId = keyof typeof DOCS;

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
const chapters = (md: string) => [...md.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1].trim());

export function AboutPage(props: { version: string; panelShown: boolean; narrow: boolean; glass: boolean; focus: string | null; hidePanel: () => void }) {
  const [doc, setDoc] = usePref<DocId>("ck.about.doc", "guide");
  const d = DOCS[doc] ?? DOCS.guide;

  const main = (
    <div className="page-body">
      <div className="page-bar">
        <h1>About</h1>
        <span className="spacer" />
        <span className="chip">CorridorKey Desktop {versionText(props.version)}</span>
      </div>
      <article className="page-content doc">
        <Markdown
          remarkPlugins={[remarkGfm]}
          components={{
            h2: ({ children }) => <h2 id={slug(String(children))}>{children}</h2>,
            a: ({ href, children }) => (
              <a href={href} target="_blank" rel="noreferrer">
                {children}
              </a>
            ),
          }}
        >
          {d.text}
        </Markdown>
      </article>
    </div>
  );

  const panel = (
    <Accordion page="about" focus={props.focus}>
      {(Object.keys(DOCS) as DocId[]).map((id) => (
        <Section key={id} id={id} icon={DOCS[id].icon} title={DOCS[id].title} status={id === doc ? "Shown" : "Click a chapter to read it"}>
          {() => (
            <ul className="chapters">
              {chapters(DOCS[id].text).map((h) => (
                <li key={h}>
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => {
                      setDoc(id);
                      requestAnimationFrame(() => document.getElementById(slug(h))?.scrollIntoView({ behavior: "smooth" }));
                    }}
                  >
                    {h}
                  </button>
                </li>
              ))}
              {chapters(DOCS[id].text).length === 0 && (
                <li>
                  <button type="button" className="link-btn" onClick={() => setDoc(id)}>
                    Open
                  </button>
                </li>
              )}
            </ul>
          )}
        </Section>
      ))}
    </Accordion>
  );

  return <SplitView main={main} panel={panel} panelTitle="About" panelSub={d.title} shown={props.panelShown} narrow={props.narrow} glass={props.glass} onEscape={props.hidePanel} />;
}
