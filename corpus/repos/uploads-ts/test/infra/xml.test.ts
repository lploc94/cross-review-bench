import { describe, expect, it } from "vitest";
import { childElements, childText, escapeXml, parseXml, XmlParseError } from "../../src/infra/xml.js";

describe("parseXml", () => {
  it("parses an S3 listing with entities, CDATA and comments", () => {
    const doc = parseXml(`<?xml version="1.0" encoding="UTF-8"?>
      <!-- listing -->
      <ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
        <Name>media</Name>
        <Contents><Key>a&amp;b/&#233;t&#xE9;.txt</Key><Size>12</Size></Contents>
        <Contents><Key><![CDATA[x<y>.bin]]></Key><Size>3</Size></Contents>
        <IsTruncated>false</IsTruncated>
      </ListBucketResult>`);
    expect(doc.name).toBe("ListBucketResult");
    expect(doc.attributes.xmlns).toBe("http://s3.amazonaws.com/doc/2006-03-01/");
    expect(childElements(doc, "Contents").map((entry) => childText(entry, "Key"))).toEqual([
      "a&b/été.txt",
      "x<y>.bin",
    ]);
    expect(childText(doc, "IsTruncated")).toBe("false");
  });

  it("handles self-closing elements and single-quoted attributes", () => {
    const doc = parseXml("<a><b flag='on'/><c>text</c></a>");
    expect(doc.children.map((child) => child.name)).toEqual(["b", "c"]);
    expect(doc.children[0]?.attributes.flag).toBe("on");
  });

  it.each([
    ["<a><b></a>", "mismatched tags"],
    ["<a>", "unclosed element"],
    ["<a/><b/>", "two roots"],
    ["<a>&unknown;</a>", "unknown entity"],
    ["<a>fish & chips</a>", "bare ampersand"],
    ['<!DOCTYPE a [<!ENTITY x "y">]><a>&x;</a>', "document type declaration"],
    [`${"<a>".repeat(40)}${"</a>".repeat(40)}`, "excessive nesting"],
  ])("rejects %j (%s)", (input) => {
    expect(() => parseXml(input)).toThrow(XmlParseError);
  });

  it("escapes text for documents it builds", () => {
    expect(escapeXml(`a<b>&"c'`)).toBe("a&lt;b&gt;&amp;&quot;c&apos;");
  });
});
