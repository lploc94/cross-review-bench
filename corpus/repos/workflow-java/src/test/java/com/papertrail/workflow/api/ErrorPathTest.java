package com.papertrail.workflow.api;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.papertrail.workflow.support.IntegrationTestBase;
import jakarta.servlet.RequestDispatcher;
import org.junit.jupiter.api.Test;

class ErrorPathTest extends IntegrationTestBase {

  @Test
  void theErrorPathAnswersAProblemDetailNotAFrameworkBody() throws Exception {
    mvc.perform(get("/error"))
        .andExpect(status().isNotFound())
        .andExpect(jsonPath("$.type").value("urn:workflow:problem:no-such-route"));
  }

  @Test
  void aForwardedErrorNamesTheCallersPathAsItsInstance() throws Exception {
    mvc.perform(
            get("/error")
                .requestAttr(RequestDispatcher.ERROR_STATUS_CODE, 404)
                .requestAttr(RequestDispatcher.ERROR_REQUEST_URI, "/api/v1/documents/9"))
        .andExpect(status().isNotFound())
        .andExpect(jsonPath("$.type").value("urn:workflow:problem:http-error"))
        .andExpect(jsonPath("$.instance").value("/api/v1/documents/9"));
  }

  @Test
  void anUnusualClientStatusIsKeptAsAnHttpError() throws Exception {
    mvc.perform(
            get("/error")
                .requestAttr(RequestDispatcher.ERROR_STATUS_CODE, 499)
                .requestAttr(RequestDispatcher.ERROR_REQUEST_URI, "/api/v1/tasks/3"))
        .andExpect(status().is(499))
        .andExpect(jsonPath("$.type").value("urn:workflow:problem:http-error"))
        .andExpect(jsonPath("$.instance").value("/api/v1/tasks/3"));
  }

  @Test
  void aNonErrorStatusForwardedAsAnErrorIsAnUnexpectedFailure() throws Exception {
    mvc.perform(
            get("/error")
                .requestAttr(RequestDispatcher.ERROR_STATUS_CODE, 302)
                .requestAttr(RequestDispatcher.ERROR_REQUEST_URI, "/api/v1/tasks/3"))
        .andExpect(status().isInternalServerError())
        .andExpect(jsonPath("$.type").value("urn:workflow:problem:unexpected"));
  }
}
