package com.papertrail.workflow.api;

import com.papertrail.workflow.domain.ConflictException;
import com.papertrail.workflow.domain.ForbiddenException;
import com.papertrail.workflow.domain.InvalidTransitionException;
import com.papertrail.workflow.domain.NotFoundException;
import com.papertrail.workflow.domain.ValidationException;
import jakarta.validation.ConstraintViolationException;
import java.net.URI;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.orm.ObjectOptimisticLockingFailureException;
import org.springframework.web.ErrorResponse;
import org.springframework.web.HttpMediaTypeNotAcceptableException;
import org.springframework.web.HttpMediaTypeNotSupportedException;
import org.springframework.web.HttpRequestMethodNotSupportedException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.MissingServletRequestParameterException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import org.springframework.web.servlet.resource.NoResourceFoundException;

/**
 * Maps the service's errors and request problems to RFC 9457 problem details. A document the caller
 * may not see is a 404, never a 403, and messages never echo titles, bodies or addresses.
 */
@RestControllerAdvice
@Order(Ordered.HIGHEST_PRECEDENCE)
public class ApiExceptionHandler {

  private static final Logger LOG = LoggerFactory.getLogger(ApiExceptionHandler.class);

  @ExceptionHandler(NotFoundException.class)
  public ProblemDetail notFound(NotFoundException e) {
    return problem(HttpStatus.NOT_FOUND, "not-found", "Not found", e.getMessage());
  }

  @ExceptionHandler(ForbiddenException.class)
  public ProblemDetail forbidden(ForbiddenException e) {
    return problem(HttpStatus.FORBIDDEN, "forbidden", "Forbidden", e.getMessage());
  }

  @ExceptionHandler(InvalidTransitionException.class)
  public ProblemDetail invalidTransition(InvalidTransitionException e) {
    return problem(HttpStatus.CONFLICT, "invalid-transition", "Invalid transition", e.getMessage());
  }

  @ExceptionHandler(ConflictException.class)
  public ProblemDetail conflict(ConflictException e) {
    return problem(HttpStatus.CONFLICT, "conflict", "Conflict", e.getMessage());
  }

  @ExceptionHandler(ValidationException.class)
  public ProblemDetail invalid(ValidationException e) {
    return problem(HttpStatus.BAD_REQUEST, "invalid-request", "Invalid request", e.getMessage());
  }

  @ExceptionHandler(NoResourceFoundException.class)
  public ProblemDetail noSuchRoute(NoResourceFoundException e) {
    return problem(HttpStatus.NOT_FOUND, "no-such-route", "Not found", "no route for this path");
  }

  /** Two writes that pass the existence checks can still race to one unique key. */
  @ExceptionHandler(DataIntegrityViolationException.class)
  public ProblemDetail uniqueKeyRace(DataIntegrityViolationException e) {
    return problem(
        HttpStatus.CONFLICT,
        "conflict",
        "Conflict",
        "the change conflicts with stored data; check the request and try again");
  }

  @ExceptionHandler(ObjectOptimisticLockingFailureException.class)
  public ProblemDetail concurrentUpdate(ObjectOptimisticLockingFailureException e) {
    return problem(
        HttpStatus.CONFLICT,
        "concurrent-update",
        "Concurrent update",
        "the resource changed while the request was processed; reload and try again");
  }

  @ExceptionHandler(HttpRequestMethodNotSupportedException.class)
  public ResponseEntity<ProblemDetail> wrongMethod(HttpRequestMethodNotSupportedException e) {
    ProblemDetail problem =
        problem(
            HttpStatus.METHOD_NOT_ALLOWED,
            "method-not-allowed",
            "Method not allowed",
            "this path does not accept " + e.getMethod());
    var response = ResponseEntity.status(HttpStatus.METHOD_NOT_ALLOWED);
    Set<HttpMethod> allowed = e.getSupportedHttpMethods();
    if (allowed != null && !allowed.isEmpty()) {
      response.allow(allowed.toArray(HttpMethod[]::new));
    }
    return response.body(problem);
  }

  @ExceptionHandler(MethodArgumentNotValidException.class)
  public ProblemDetail beanValidation(MethodArgumentNotValidException e) {
    List<Map<String, String>> errors =
        e.getBindingResult().getFieldErrors().stream()
            .map(
                error ->
                    Map.of(
                        "field",
                        error.getField(),
                        "message",
                        String.valueOf(error.getDefaultMessage())))
            .toList();
    ProblemDetail detail =
        problem(HttpStatus.BAD_REQUEST, "validation-failed", "Validation failed", "see errors");
    detail.setProperty("errors", errors);
    return detail;
  }

  @ExceptionHandler(ConstraintViolationException.class)
  public ProblemDetail parameterValidation(ConstraintViolationException e) {
    return problem(
        HttpStatus.BAD_REQUEST, "validation-failed", "Validation failed", e.getMessage());
  }

  @ExceptionHandler(MissingServletRequestParameterException.class)
  public ProblemDetail missingParameter(MissingServletRequestParameterException e) {
    return problem(
        HttpStatus.BAD_REQUEST,
        "invalid-request",
        "Invalid request",
        "the parameter " + e.getParameterName() + " is required");
  }

  @ExceptionHandler(MethodArgumentTypeMismatchException.class)
  public ProblemDetail typeMismatch(MethodArgumentTypeMismatchException e) {
    return problem(
        HttpStatus.BAD_REQUEST,
        "malformed-request",
        "Malformed request",
        "parameter " + e.getName() + " has an invalid value");
  }

  @ExceptionHandler(HttpMessageNotReadableException.class)
  public ProblemDetail unreadable(HttpMessageNotReadableException e) {
    return problem(
        HttpStatus.BAD_REQUEST,
        "malformed-request",
        "Malformed request",
        "the body is not valid JSON for this request");
  }

  @ExceptionHandler(HttpMediaTypeNotSupportedException.class)
  public ProblemDetail wrongRequestType(HttpMediaTypeNotSupportedException e) {
    return problem(
        HttpStatus.UNSUPPORTED_MEDIA_TYPE,
        "unsupported-media-type",
        "Unsupported media type",
        "send the body as application/json");
  }

  @ExceptionHandler(HttpMediaTypeNotAcceptableException.class)
  public ProblemDetail unacceptableResponse(HttpMediaTypeNotAcceptableException e) {
    return problem(
        HttpStatus.NOT_ACCEPTABLE,
        "not-acceptable",
        "Not acceptable",
        "this API answers in application/json or application/problem+json");
  }

  /**
   * Any other failure is logged in full and answered with a generic problem: the message of an
   * unexpected exception can carry SQL, paths or data, so it never reaches the caller. Framework
   * errors that already carry a status keep it.
   */
  @ExceptionHandler(Exception.class)
  public ResponseEntity<ProblemDetail> unexpected(Exception e) {
    if (e instanceof ErrorResponse framework) {
      return ResponseEntity.status(framework.getStatusCode())
          .headers(framework.getHeaders())
          .body(framework.getBody());
    }
    LOG.error("unhandled request failure", e);
    return ResponseEntity.internalServerError()
        .body(
            problem(
                HttpStatus.INTERNAL_SERVER_ERROR,
                "unexpected",
                "Internal error",
                "the request failed; try again later"));
  }

  /** A request path as a URI; a path that cannot be one becomes "/". */
  static String encodedPath(String path) {
    try {
      return new URI(null, null, path, null).toASCIIString();
    } catch (java.net.URISyntaxException e) {
      return "/";
    }
  }

  static ProblemDetail problem(HttpStatus status, String slug, String title, String detail) {
    ProblemDetail problem = ProblemDetail.forStatusAndDetail(status, detail);
    problem.setType(URI.create("urn:workflow:problem:" + slug));
    problem.setTitle(title);
    return problem;
  }
}
