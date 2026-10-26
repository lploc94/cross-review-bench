package com.papertrail.workflow.api;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.papertrail.workflow.support.IntegrationTestBase;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;

/** The framework's own request problems answer with the same RFC 9457 types as ours. */
class ProblemRoutesTest extends IntegrationTestBase {

  private static final String AUTH = "Authorization";

  @Test
  void aWrongRequestMediaTypeIsAProblemDetail() throws Exception {
    long owner = data.user("Ines Berg");

    mvc.perform(
            post("/api/v1/documents")
                .header(AUTH, data.bearer(owner))
                .contentType(MediaType.TEXT_PLAIN)
                .content("not json"))
        .andExpect(status().isUnsupportedMediaType())
        .andExpect(jsonPath("$.type").value("urn:workflow:problem:unsupported-media-type"));
  }

  @Test
  void anUnacceptableResponseTypeIsAProblemDetail() throws Exception {
    long owner = data.user("Ines Berg");

    mvc.perform(
            get("/api/v1/definitions")
                .header(AUTH, data.bearer(owner))
                .accept(MediaType.APPLICATION_XML))
        .andExpect(status().isNotAcceptable())
        .andExpect(jsonPath("$.type").value("urn:workflow:problem:not-acceptable"));
  }
}
