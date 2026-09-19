import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import word from "./fixtures/word-features.docx?inline";
import { ImportError } from "../../src/client/convert/model";
import { readDocx } from "../../src/client/convert/docx/read-docx";
import { buildDocx, p } from "./build-docx";
import { findAll, fixtureBytes, markTypes, parseXml, textNodes, textOf } from "./helpers";

const read = (data: Uint8Array, fileName = "test.docx") => readDocx(data, { parseXml, fileName });

describe("a document made in Word", () => {
  const doc = read(fixtureBytes(word), "word-features.docx");
  const content = doc.content;

  it("keeps the title, headings and paragraph formatting", () => {
    expect(doc.title).toBe("Quarterly report");
    const headings = findAll(content, "heading").map((h) => [h.attrs!.level, textOf(h)]);
    expect(headings).toEqual([
      [1, "Quarterly report"], // Title
      [1, "Introduction"],
      [2, "Lists"],
      [3, "Table"],
      [1, "Review"],
    ]);
    const paragraphs = findAll(content, "paragraph");
    const byText = (text: string) => paragraphs.find((node) => textOf(node) === text)!;
    expect(byText("Centred paragraph").attrs!.textAlign).toBe("center");
    expect(byText("Right paragraph").attrs!.textAlign).toBe("right");
    expect(byText("Indented paragraph").attrs!.indent).toBe(1);
  });

  it("keeps character formatting, fonts, sizes and colours", () => {
    const marks = (text: string) => markTypes(textNodes(content, text)[0]);
    expect(marks("Bold")).toContain("bold");
    expect(marks("italic")).toContain("italic");
    expect(marks("underlined")).toContain("underline");
    expect(marks("struck")).toContain("strike");
    expect(markTypes(textNodes(content, "2").find((t) => t.text === "2")!)).toContain("subscript");
    expect(markTypes(textNodes(content, "3").find((t) => t.text === "3")!)).toContain("superscript");
    const style = (text: string) => textNodes(content, text)[0].marks!.find((m) => m.type === "textStyle")?.attrs;
    expect(style("red")?.color).toBe("#ff0000");
    // Office fonts map to Colo's metric-compatible ones; others keep their name.
    expect(style("Times 14")).toMatchObject({ fontFamily: "Tinos, 'Times New Roman', serif", fontSize: "14pt" });
    expect(style("mono")?.fontFamily).toBe("Cousine, 'Courier New', monospace");
    expect(style("Bold")).toMatchObject({ fontFamily: "'Aptos', sans-serif", fontSize: "12pt" });
    expect(textNodes(content, "highlighted")[0].marks).toContainEqual({ type: "highlight", attrs: { color: "#ffff00" } });
  });

  it("nests bullet and numbered lists and keeps checklists", () => {
    const [bullets] = findAll(content, "bulletList");
    expect(bullets.content!.map((item) => textOf(item.content![0]))).toEqual(["First bullet", "Second bullet"]);
    expect(textOf(findAll(bullets.content![0], "bulletList")[0])).toBe("Nested bullet");
    const [numbers] = findAll(content, "orderedList");
    expect(numbers.content!.map((item) => textOf(item.content![0]))).toEqual(["First number", "Second number"]);
    expect(textOf(findAll(numbers.content![0], "orderedList")[0])).toBe("Nested number");
    const [task] = findAll(content, "taskItem");
    expect(task.attrs).toEqual({ checked: true });
    expect(textOf(task)).toBe("Done task");
  });

  it("keeps the table with its header row, widths and merged cells", () => {
    const [table] = findAll(content, "table");
    const rows = table.content!;
    expect(rows[0].content!.map((cell) => cell.type)).toEqual(["tableHeader", "tableHeader", "tableHeader"]);
    expect(rows[0].content![0].attrs!.colwidth).toEqual([304]);
    const spansRows = rows[1].content!.find((cell) => textOf(cell) === "Spans rows")!;
    expect(spansRows.attrs!.rowspan).toBe(2);
    expect(rows[2].content).toHaveLength(1);
    expect(rows[2].content![0].attrs).toMatchObject({ colspan: 2, colwidth: [304, 304] });
  });

  it("keeps the image, the link and the quote", () => {
    const [image] = findAll(content, "image");
    expect(image.attrs).toMatchObject({ src: "pending:image1", width: 400, height: 200, textAlign: "center" });
    expect(doc.images.get("image1")?.type).toBe("image/png");
    expect(textNodes(content, "Colo website")[0].marks).toContainEqual({ type: "link", attrs: { href: "https://example.com/" } });
    expect(textOf(findAll(content, "blockquote")[0])).toBe("A quotation worth keeping.");
    expect(findAll(content, "pageBreak")).toHaveLength(1);
  });

  it("accepts tracked changes, moves footnotes to Notes and keeps text boxes as text", () => {
    const review = findAll(content, "paragraph").find((node) => textOf(node).startsWith("This claim"))!;
    expect(textOf(review)).toBe("This claim1 needs a source here. Inserted words. Old wording.");
    const notes = findAll(content, "orderedList").at(-1)!;
    expect(textOf(notes)).toBe("Footnote text.");
    expect(findAll(content, "paragraph").some((node) => textOf(node) === "Boxed text")).toBe(true);
    expect(doc.notes.map((note) => note.message)).toEqual([
      "Tracked changes were accepted",
      "Text boxes became ordinary paragraphs",
      "Footnotes and endnotes were moved to a numbered Notes list at the end",
    ]);
  });

  it("reads comment threads with replies, resolved state and their text ranges", () => {
    expect(doc.threads).toHaveLength(2);
    const [open, resolved] = doc.threads;
    expect(open).toMatchObject({ quote: "a source", resolved: false });
    expect(open.comments.map((c) => [c.author, c.body])).toEqual([
      ["Sam Reviewer", "Please cite this."],
      ["Alex Writer", "Added a citation."],
    ]);
    expect(resolved).toMatchObject({ quote: "discussion", resolved: true });
    expect(textNodes(content, "a source")[0].marks).toContainEqual({ type: "comment", attrs: { threadId: open.id } });
    expect(textNodes(content, "discussion")[0].marks).toContainEqual({ type: "comment", attrs: { threadId: resolved.id } });
  });

  it("reads page setup and the header and footer", () => {
    expect(doc.settings).toEqual({
      pageSize: "LETTER",
      orientation: "landscape",
      margins: { top: 25.4, bottom: 25.4, left: 19, right: 19 },
      header: { left: "Colo fixture", right: "Page {page} of {total}" },
      footer: { left: "Confidential", right: "" },
    });
  });
});

describe("edge cases", () => {
  it("links: fields become links, internal anchors keep only their text, unsafe ones are dropped", () => {
    const doc = read(
      buildDocx(
        `<w:p><w:fldSimple w:instr=' HYPERLINK "https://field.example/" '><w:r><w:t>field</w:t></w:r></w:fldSimple>
         <w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>HYPERLINK "https://complex.example/"</w:instrText></w:r>
         <w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>complex</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>
         <w:hyperlink w:anchor="_Toc1"><w:r><w:t>anchor</w:t></w:r></w:hyperlink>
         <w:hyperlink r:id="rBad"><w:r><w:t>script</w:t></w:r></w:hyperlink></w:p>`,
        { rels: { rBad: ["hyperlink", "javascript:alert(1)", true] } },
      ),
    );
    const link = (text: string) => textNodes(doc.content, text)[0].marks?.find((m) => m.type === "link")?.attrs?.href;
    expect(link("field")).toBe("https://field.example/");
    expect(link("complex")).toBe("https://complex.example/");
    expect(link("anchor")).toBeUndefined();
    expect(link("script")).toBeUndefined();
    expect(textOf(doc.content)).toBe("fieldcomplexanchorscript");
  });

  it("notes what it leaves out: equations, EMF images, charts, linked images", () => {
    const drawing = (inner: string) =>
      `<w:r><w:drawing><wp:inline><wp:extent cx="952500" cy="952500"/><wp:docPr id="1" name="x"/><a:graphic><a:graphicData uri="${inner}"/></a:graphic></wp:inline></w:drawing></w:r>`;
    const picture = (attrs: string) =>
      `<w:r><w:drawing><wp:inline><wp:extent cx="952500" cy="952500"/><wp:docPr id="2" name="y"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:blipFill><a:blip ${attrs}/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
    const doc = read(
      buildDocx(
        `<w:p><w:r><w:t>E = </w:t></w:r><m:oMath><m:r><m:t>mc2</m:t></m:r></m:oMath></w:p>
         <w:p>${picture('r:embed="rEmf"')}${drawing("http://schemas.openxmlformats.org/drawingml/2006/chart")}${picture('r:link="rLinked"')}</w:p>`,
        {
          rels: { rEmf: ["image", "media/image1.emf"], rLinked: ["image", "https://example.com/a.png", true] },
          parts: { "word/media/image1.emf": new Uint8Array([1, 0, 0, 0]) },
        },
      ),
    );
    expect(textOf(doc.content)).toBe("E = ");
    expect(findAll(doc.content, "image")).toHaveLength(0);
    expect(doc.notes.map((n) => n.message).sort()).toEqual(
      [
        "Charts, diagrams and shapes were left out",
        "Equations were left out",
        "Images in formats browsers cannot show (EMF, WMF, TIFF) were left out",
        "Images linked from outside the file were left out",
      ].sort(),
    );
  });

  it("a numbered list interrupted by a paragraph keeps counting", () => {
    const numbering = `<?xml version="1.0"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum>
      <w:num w:numId="5"><w:abstractNumId w:val="0"/></w:num></w:numbering>`;
    const item = (text: string) => `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="5"/></w:numPr></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
    const doc = read(buildDocx(`${item("one")}${item("two")}${p("between")}${item("three")}`, {
      rels: { rNum: ["numbering", "numbering.xml"] },
      parts: { "word/numbering.xml": numbering },
    }));
    const lists = findAll(doc.content, "orderedList");
    expect(lists).toHaveLength(2);
    expect(lists[1].attrs).toEqual({ start: 3 });
  });

  it("an empty paragraph with a bottom border is a horizontal line; blank lines are kept", () => {
    const doc = read(buildDocx(`${p("above")}<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6"/></w:pBdr></w:pPr></w:p><w:p/>${p("below")}`));
    expect(doc.content.content!.map((n) => n.type)).toEqual(["paragraph", "horizontalRule", "paragraph", "paragraph"]);
  });
});

describe("files Colo cannot open", () => {
  const expectImportError = (data: Uint8Array, message: RegExp, limits?: Parameters<typeof readDocx>[1]["limits"]) => {
    expect(() => readDocx(data, { parseXml, limits })).toThrow(ImportError);
    expect(() => readDocx(data, { parseXml, limits })).toThrow(message);
  };

  it("explains what is wrong", () => {
    expectImportError(strToU8("just some text"), /not a Word document/);
    expectImportError(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0, 0]), /Word 97–2003/);
    expectImportError(zipSync({ "hello.txt": strToU8("hi") }), /no readable document/);
    expectImportError(new Uint8Array([0x50, 0x4b, 3, 4, 9, 9, 9]), /damaged/);
  });

  it("refuses a document whose XML is broken", () => {
    const broken = zipSync({ "word/document.xml": strToU8("<w:document><w:body><w:p>") });
    expectImportError(broken, /no readable document/);
  });

  it("refuses files that expand beyond the limit before inflating them", () => {
    const bomb = zipSync({ "word/document.xml": new Uint8Array(5_000) }, { level: 9 });
    expectImportError(bomb, /expands to more/, { fileBytes: 1_000_000, unzippedBytes: 1_000, parts: 10 });
    expectImportError(bomb, /larger than/, { fileBytes: 10, unzippedBytes: 1_000_000, parts: 10 });
  });
});
