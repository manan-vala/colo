import { NS, attr, child, children, intAttr, onOff, val } from "./xml";

/**
 * Word formatting is inherited: document defaults, then the paragraph style and the styles it
 * is based on, then the character style, then the run itself. This resolves that chain into
 * plain property objects.
 */

export interface RunProps {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  vertAlign?: "sub" | "super";
  /** #rrggbb */
  color?: string;
  /** #rrggbb */
  highlight?: string;
  /** Office font name. */
  font?: string;
  /** Points. */
  size?: number;
}

export interface ParaProps {
  align?: "left" | "center" | "right" | "justify";
  /** Twips. */
  indentLeft?: number;
  numId?: string;
  ilvl?: number;
  /** 0-based outline level, set by heading styles. */
  outlineLevel?: number;
  pageBreakBefore?: boolean;
  borderBottom?: boolean;
}

interface Style {
  id: string;
  name: string;
  basedOn: string | null;
  para: ParaProps;
  run: RunProps;
}

/** Word's named highlight colours. */
const HIGHLIGHTS: Record<string, string> = {
  yellow: "#ffff00",
  green: "#00ff00",
  cyan: "#00ffff",
  magenta: "#ff00ff",
  blue: "#0000ff",
  red: "#ff0000",
  darkBlue: "#000080",
  darkCyan: "#008080",
  darkGreen: "#008000",
  darkMagenta: "#800080",
  darkRed: "#800000",
  darkYellow: "#808000",
  darkGray: "#808080",
  lightGray: "#c0c0c0",
  black: "#000000",
  white: "#ffffff",
};

const hexColor = (value: string | null): string | undefined =>
  value && /^[0-9a-f]{6}$/i.test(value) ? `#${value.toLowerCase()}` : undefined;

export interface ThemeFonts {
  major: string | null;
  minor: string | null;
}

export function readThemeFonts(theme: Document | null): ThemeFonts {
  const font = (kind: string) => {
    const scheme = theme ? Array.from(theme.getElementsByTagNameNS(NS.a, kind))[0] : undefined;
    const latin = scheme ? child(scheme, NS.a, "latin") : null;
    return latin?.getAttribute("typeface") || null;
  };
  return { major: font("majorFont"), minor: font("minorFont") };
}

/** Run properties written on an element's `w:rPr`. */
export function readRunProps(rPr: Element | null, theme: ThemeFonts): RunProps {
  if (!rPr) return {};
  const props: RunProps = {};
  const set = <K extends keyof RunProps>(key: K, value: RunProps[K] | undefined) => {
    if (value !== undefined) props[key] = value;
  };
  set("bold", onOff(rPr, "b"));
  set("italic", onOff(rPr, "i"));
  const underline = child(rPr, NS.w, "u");
  if (underline) props.underline = attr(underline, NS.w, "val") !== "none";
  const strike = onOff(rPr, "strike") ?? onOff(rPr, "dstrike");
  set("strike", strike);
  const vert = val(rPr, "vertAlign");
  if (vert === "subscript") props.vertAlign = "sub";
  else if (vert === "superscript") props.vertAlign = "super";
  const color = val(rPr, "color");
  if (color === "auto") props.color = "#000000";
  else set("color", hexColor(color));
  const highlight = val(rPr, "highlight");
  if (highlight && highlight !== "none") set("highlight", HIGHLIGHTS[highlight]);
  const shading = hexColor(attr(child(rPr, NS.w, "shd"), NS.w, "fill"));
  if (shading && !props.highlight) props.highlight = shading;
  const fonts = child(rPr, NS.w, "rFonts");
  if (fonts) {
    const theme_ = attr(fonts, NS.w, "asciiTheme") ?? attr(fonts, NS.w, "hAnsiTheme");
    const named = attr(fonts, NS.w, "ascii") ?? attr(fonts, NS.w, "hAnsi");
    const fromTheme = theme_ ? (theme_.startsWith("major") ? theme.major : theme.minor) : null;
    set("font", named ?? fromTheme ?? undefined);
  }
  const size = intAttr(child(rPr, NS.w, "sz"), NS.w, "val");
  if (size !== null && size > 0) props.size = size / 2;
  return props;
}

/** Paragraph properties written on an element's `w:pPr`. */
export function readParaProps(pPr: Element | null): ParaProps {
  if (!pPr) return {};
  const props: ParaProps = {};
  const jc = val(pPr, "jc");
  if (jc === "center") props.align = "center";
  else if (jc === "right" || jc === "end") props.align = "right";
  else if (jc === "both" || jc === "distribute") props.align = "justify";
  else if (jc === "left" || jc === "start") props.align = "left";
  const ind = child(pPr, NS.w, "ind");
  const left = intAttr(ind, NS.w, "left") ?? intAttr(ind, NS.w, "start");
  if (left !== null) props.indentLeft = left;
  const numPr = child(pPr, NS.w, "numPr");
  if (numPr) {
    const numId = val(numPr, "numId");
    if (numId !== null) props.numId = numId;
    const ilvl = val(numPr, "ilvl");
    if (ilvl !== null) props.ilvl = Number(ilvl) || 0;
  }
  const outline = val(pPr, "outlineLvl");
  if (outline !== null) props.outlineLevel = Number(outline);
  const pageBreak = onOff(pPr, "pageBreakBefore");
  if (pageBreak !== undefined) props.pageBreakBefore = pageBreak;
  const bottom = child(child(pPr, NS.w, "pBdr"), NS.w, "bottom");
  if (bottom && attr(bottom, NS.w, "val") !== "none" && attr(bottom, NS.w, "val") !== "nil") props.borderBottom = true;
  return props;
}

export class Styles {
  private readonly paragraphStyles = new Map<string, Style>();
  private readonly characterStyles = new Map<string, Style>();
  private readonly defaultRun: RunProps;
  private readonly defaultPara: ParaProps;
  private readonly defaultParagraphStyle: string | null = null;

  constructor(
    styles: Document | null,
    private readonly theme: ThemeFonts,
  ) {
    const root = styles?.documentElement;
    const defaults = child(root, NS.w, "docDefaults");
    this.defaultRun = readRunProps(child(child(defaults, NS.w, "rPrDefault"), NS.w, "rPr"), theme);
    this.defaultPara = readParaProps(child(child(defaults, NS.w, "pPrDefault"), NS.w, "pPr"));
    for (const element of root ? children(root, NS.w, "style") : []) {
      const id = attr(element, NS.w, "styleId");
      if (!id) continue;
      const style: Style = {
        id,
        name: val(element, "name") ?? id,
        basedOn: val(element, "basedOn"),
        para: readParaProps(child(element, NS.w, "pPr")),
        run: readRunProps(child(element, NS.w, "rPr"), theme),
      };
      const type = attr(element, NS.w, "type");
      if (type === "paragraph") {
        this.paragraphStyles.set(id, style);
        if (attr(element, NS.w, "default") === "1") this.defaultParagraphStyle = id;
      } else if (type === "character") {
        this.characterStyles.set(id, style);
      }
    }
  }

  /** The paragraph style's display name ("heading 1", "List Bullet 2", "Quote"…). */
  paragraphStyleName(id: string | null): string {
    const style = this.paragraphStyles.get(id ?? this.defaultParagraphStyle ?? "");
    return style?.name ?? "";
  }

  resolvePara(styleId: string | null, direct: ParaProps): ParaProps {
    return { ...this.defaultPara, ...this.chain(this.paragraphStyles, styleId ?? this.defaultParagraphStyle, (s) => s.para), ...direct };
  }

  resolveRun(paraStyleId: string | null, charStyleId: string | null, direct: RunProps): RunProps {
    return {
      ...this.defaultRun,
      ...this.chain(this.paragraphStyles, paraStyleId ?? this.defaultParagraphStyle, (s) => s.run),
      ...this.chain(this.characterStyles, charStyleId, (s) => s.run),
      ...direct,
    };
  }

  runProps(rPr: Element | null): RunProps {
    return readRunProps(rPr, this.theme);
  }

  /** Merges a style with the styles it is based on, the base first. */
  private chain<T extends object>(styles: Map<string, Style>, id: string | null, pick: (style: Style) => T): T {
    const stack: T[] = [];
    const seen = new Set<string>();
    for (let style = id ? styles.get(id) : undefined; style && !seen.has(style.id); style = style.basedOn ? styles.get(style.basedOn) : undefined) {
      seen.add(style.id);
      stack.unshift(pick(style));
    }
    return Object.assign({}, ...stack) as T;
  }
}
