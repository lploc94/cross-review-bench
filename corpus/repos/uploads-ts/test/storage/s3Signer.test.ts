import { describe, expect, it } from "vitest";
import {
  canonicalQueryString,
  canonicalRequest,
  encodeKeyPath,
  sha256Hex,
  signature,
  signRequest,
  stringToSign,
} from "../../src/storage/s3Signer.js";

// The GetObject example from the AWS Signature Version 4 documentation for S3.
const credentials = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};
const date = new Date("2013-05-24T00:00:00Z");
const scope = { region: "us-east-1", service: "s3" };
const emptyHash = sha256Hex("");

describe("SigV4 signing", () => {
  it("reproduces the documented GetObject signature", () => {
    const url = new URL("https://examplebucket.s3.amazonaws.com/test.txt");
    const { canonical, signedHeaders } = canonicalRequest(
      "GET",
      url,
      {
        host: "examplebucket.s3.amazonaws.com",
        range: "bytes=0-9",
        "x-amz-content-sha256": emptyHash,
        "x-amz-date": "20130524T000000Z",
      },
      emptyHash,
    );
    expect(signedHeaders).toBe("host;range;x-amz-content-sha256;x-amz-date");
    expect(stringToSign(date, scope, canonical)).toBe(
      "AWS4-HMAC-SHA256\n20130524T000000Z\n20130524/us-east-1/s3/aws4_request\n" +
        "7344ae5b7ee6c3e7e6b0fe0640412a37625d1fbfff95c48bbb2dc43964946972",
    );
    expect(signature(credentials, date, scope, canonical)).toBe(
      "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
  });

  it("signRequest produces the same Authorization header", () => {
    const headers = signRequest(
      {
        method: "GET",
        url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
        headers: { Range: "bytes=0-9" },
        payloadHash: emptyHash,
      },
      credentials,
      scope,
      date,
    );
    expect(headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " +
        "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, " +
        "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
  });

  it("sorts and encodes query parameters", () => {
    expect(canonicalQueryString("?prefix=a b&list-type=2&delimiter=%2F&uploads")).toBe(
      "delimiter=%2F&list-type=2&prefix=a%20b&uploads=",
    );
  });

  it("encodes each key segment and keeps the slashes", () => {
    expect(encodeKeyPath("staging/a b/(1)*!.txt")).toBe("staging/a%20b/%281%29%2A%21.txt");
  });
});
