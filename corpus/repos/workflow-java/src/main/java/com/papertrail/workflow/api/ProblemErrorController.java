package com.papertrail.workflow.api;

import jakarta.servlet.RequestDispatcher;
import jakarta.servlet.http.HttpServletRequest;
import java.net.URI;
import org.springframework.boot.web.servlet.error.ErrorController;
import org.springframework.http.HttpStatus;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.ProblemDetail;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Answers the container's error path as a problem detail, so no route returns a framework body. A
 * direct request to the path has no error status and is a 404. A forwarded error keeps its 4xx or
 * 5xx status and names the caller's own path as the instance; a 5xx gets the generic body of the
 * catch-all. A status that is not an error (a redirect, say) is an unexpected failure.
 */
@RestController
public class ProblemErrorController implements ErrorController {

  @RequestMapping("/error")
  public ResponseEntity<ProblemDetail> error(HttpServletRequest request) {
    Object code = request.getAttribute(RequestDispatcher.ERROR_STATUS_CODE);
    if (!(code instanceof Integer status)) {
      return answer(404, "no-such-route", "Not found", "no route for this path", request);
    }
    if (status >= 400 && status < 500) {
      HttpStatus known = HttpStatus.resolve(status);
      String title = known == null ? "Client error" : known.getReasonPhrase();
      return answer(status, "http-error", title, "the request could not be answered", request);
    }
    if (status >= 500 && status < 600) {
      return answer(
          status, "unexpected", "Internal error", "the request failed; try again later", request);
    }
    return answer(
        500, "unexpected", "Internal error", "the request failed; try again later", request);
  }

  private static ResponseEntity<ProblemDetail> answer(
      int status, String slug, String title, String detail, HttpServletRequest request) {
    ProblemDetail problem =
        ProblemDetail.forStatusAndDetail(HttpStatusCode.valueOf(status), detail);
    problem.setType(URI.create("urn:workflow:problem:" + slug));
    problem.setTitle(title);
    Object original = request.getAttribute(RequestDispatcher.ERROR_REQUEST_URI);
    if (original instanceof String path && path.startsWith("/")) {
      problem.setInstance(URI.create(ApiExceptionHandler.encodedPath(path)));
    }
    return ResponseEntity.status(status).body(problem);
  }
}
