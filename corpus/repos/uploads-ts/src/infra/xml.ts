/**
 * A small XML parser for the documents S3 answers with (error bodies, listings, multipart
 * results). It builds an element tree with attributes and text, decodes the predefined and numeric
 * character references, and skips the XML declaration, processing instructions and comments.
 * Document type declarations are refused: S3 never sends them and they are the door to entity
 * expansion attacks.
 */
export interface XmlElement {
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: XmlElement[];
  /** The element's own text content (CDATA included), with child elements left out. */
  text: string;
}

export class XmlParseError extends Error {
  constructor(message: string, position: number) {
    super(`${message} at offset ${position}`);
    this.name = "XmlParseError";
  }
}

/** S3 documents nest a few levels deep; anything deeper is refused rather than recursed into. */
export const MAX_XML_DEPTH = 32;

const NAME = /[A-Za-z_:][-A-Za-z0-9_:.]*/y;
const WHITESPACE = /\s*/y;
const PREDEFINED_ENTITIES: Record<string, string> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
};

function decodeEntities(raw: string, position: number): string {
  return raw.replace(/&([^;&\s]*);?/g, (match: string, body: string) => {
    if (!match.endsWith(";")) {
      throw new XmlParseError("unterminated character reference", position);
    }
    if (body.startsWith("#")) {
      const code = body[1] === "x" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      const digits = body[1] === "x" ? /^#x[0-9A-Fa-f]{1,6}$/ : /^#[0-9]{1,7}$/;
      if (!digits.test(body) || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) || code === 0) {
        throw new XmlParseError(`invalid character reference &${body};`, position);
      }
      return String.fromCodePoint(code);
    }
    const value = PREDEFINED_ENTITIES[body];
    if (value === undefined) {
      throw new XmlParseError(`unknown entity &${body};`, position);
    }
    return value;
  });
}

class Parser {
  private pos = 0;

  constructor(private readonly input: string) {}

  parseDocument(): XmlElement {
    this.skipProlog();
    if (this.input[this.pos] !== "<") {
      throw new XmlParseError("expected the root element", this.pos);
    }
    const root = this.parseElement(1);
    this.skipMisc();
    if (this.pos !== this.input.length) {
      throw new XmlParseError("content after the root element", this.pos);
    }
    return root;
  }

  private skipWhitespace(): void {
    WHITESPACE.lastIndex = this.pos;
    WHITESPACE.exec(this.input);
    this.pos = WHITESPACE.lastIndex;
  }

  private startsWith(token: string): boolean {
    return this.input.startsWith(token, this.pos);
  }

  private skipPast(terminator: string, what: string): void {
    const end = this.input.indexOf(terminator, this.pos);
    if (end < 0) throw new XmlParseError(`unterminated ${what}`, this.pos);
    this.pos = end + terminator.length;
  }

  /** Comments, processing instructions and whitespace, allowed before and after the root. */
  private skipMisc(): void {
    for (;;) {
      this.skipWhitespace();
      if (this.startsWith("<!--")) this.skipPast("-->", "comment");
      else if (this.startsWith("<?")) this.skipPast("?>", "processing instruction");
      else return;
    }
  }

  private skipProlog(): void {
    if (this.input.charCodeAt(0) === 0xfeff) this.pos = 1;
    this.skipMisc();
    if (this.startsWith("<!DOCTYPE") || this.startsWith("<!doctype")) {
      throw new XmlParseError("document type declarations are not accepted", this.pos);
    }
  }

  private readName(): string {
    NAME.lastIndex = this.pos;
    const match = NAME.exec(this.input);
    if (!match) throw new XmlParseError("expected a name", this.pos);
    this.pos = NAME.lastIndex;
    return match[0];
  }

  private parseAttributes(): Record<string, string> {
    const attributes: Record<string, string> = {};
    for (;;) {
      this.skipWhitespace();
      const next = this.input[this.pos];
      if (next === ">" || next === "/" || next === undefined) return attributes;
      const name = this.readName();
      this.skipWhitespace();
      if (this.input[this.pos] !== "=") throw new XmlParseError("expected =", this.pos);
      this.pos++;
      this.skipWhitespace();
      const quote = this.input[this.pos];
      if (quote !== '"' && quote !== "'") throw new XmlParseError("expected a quoted value", this.pos);
      const end = this.input.indexOf(quote, this.pos + 1);
      if (end < 0) throw new XmlParseError("unterminated attribute value", this.pos);
      const raw = this.input.slice(this.pos + 1, end);
      if (raw.includes("<")) throw new XmlParseError("< in attribute value", this.pos);
      if (Object.hasOwn(attributes, name)) {
        throw new XmlParseError(`duplicate attribute ${name}`, this.pos);
      }
      attributes[name] = decodeEntities(raw, this.pos);
      this.pos = end + 1;
    }
  }

  private parseElement(depth: number): XmlElement {
    const start = this.pos;
    if (depth > MAX_XML_DEPTH) {
      throw new XmlParseError(`elements nest deeper than ${MAX_XML_DEPTH} levels`, start);
    }
    this.pos++; // "<"
    const name = this.readName();
    const attributes = this.parseAttributes();
    const element: XmlElement = { name, attributes, children: [], text: "" };
    if (this.startsWith("/>")) {
      this.pos += 2;
      return element;
    }
    if (this.input[this.pos] !== ">") throw new XmlParseError(`malformed tag <${name}>`, start);
    this.pos++;
    for (;;) {
      if (this.pos >= this.input.length) {
        throw new XmlParseError(`element <${name}> is not closed`, start);
      }
      if (this.startsWith("</")) {
        this.pos += 2;
        const closing = this.readName();
        if (closing !== name) {
          throw new XmlParseError(`</${closing}> closes <${name}>`, this.pos);
        }
        this.skipWhitespace();
        if (this.input[this.pos] !== ">") throw new XmlParseError("malformed closing tag", this.pos);
        this.pos++;
        return element;
      }
      if (this.startsWith("<!--")) {
        this.skipPast("-->", "comment");
      } else if (this.startsWith("<![CDATA[")) {
        const end = this.input.indexOf("]]>", this.pos);
        if (end < 0) throw new XmlParseError("unterminated CDATA section", this.pos);
        element.text += this.input.slice(this.pos + 9, end);
        this.pos = end + 3;
      } else if (this.startsWith("<?")) {
        this.skipPast("?>", "processing instruction");
      } else if (this.startsWith("<!")) {
        throw new XmlParseError("declarations are not accepted inside elements", this.pos);
      } else if (this.input[this.pos] === "<") {
        element.children.push(this.parseElement(depth + 1));
      } else {
        const end = this.input.indexOf("<", this.pos);
        const stop = end < 0 ? this.input.length : end;
        element.text += decodeEntities(this.input.slice(this.pos, stop), this.pos);
        this.pos = stop;
      }
    }
  }
}

export function parseXml(input: string): XmlElement {
  return new Parser(input).parseDocument();
}

/** The first child element named `name`, or undefined. */
export function childElement(element: XmlElement, name: string): XmlElement | undefined {
  return element.children.find((child) => child.name === name);
}

/** Every child element named `name`, in document order. */
export function childElements(element: XmlElement, name: string): XmlElement[] {
  return element.children.filter((child) => child.name === name);
}

/** The text of the first child element named `name`, or undefined when there is none. */
export function childText(element: XmlElement, name: string): string | undefined {
  return childElement(element, name)?.text;
}

/** Escape text for an XML element or attribute value. */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
