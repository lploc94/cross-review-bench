package com.papertrail.workflow.api;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.http.ResponseEntity;

class ApiExceptionHandlerTest {

  private final ApiExceptionHandler handler = new ApiExceptionHandler();

  @Test
  void anUnexpectedFailureIsAGenericProblemThatHidesItsMessage() {
    ResponseEntity<ProblemDetail> response =
        handler.unexpected(new IllegalStateException("SELECT * FROM app_user at /srv/db"));

    assertThat(response.getStatusCode()).isEqualTo(HttpStatus.INTERNAL_SERVER_ERROR);
    ProblemDetail body = response.getBody();
    assertThat(body.getType().toString()).isEqualTo("urn:workflow:problem:unexpected");
    assertThat(body.getTitle()).isEqualTo("Internal error");
    assertThat(body.getDetail()).doesNotContain("SELECT").doesNotContain("/srv");
  }
}
