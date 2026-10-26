package com.innkeep.booking.api;

import com.innkeep.booking.domain.ConflictException;
import com.innkeep.booking.domain.HoldExpiredException;
import com.innkeep.booking.domain.InsufficientAvailabilityException;
import com.innkeep.booking.domain.NotFoundException;
import com.innkeep.booking.domain.PaymentFailedException;
import com.innkeep.booking.domain.ValidationException;
import jakarta.persistence.LockTimeoutException;
import jakarta.persistence.PessimisticLockException;
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
import org.springframework.dao.PessimisticLockingFailureException;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.orm.ObjectOptimisticLockingFailureException;
import org.springframework.web.ErrorResponse;
import org.springframework.web.HttpRequestMethodNotSupportedException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.MissingServletRequestParameterException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import org.springframework.web.servlet.resource.NoResourceFoundException;

/**
 * Maps the service's errors and request problems to RFC 9457 problem details. Messages never echo
 * guest contact details; payment and concurrency failures get a generic detail.
 */
@RestControllerAdvice
@Order(Ordered.HIGHEST_PRECEDENCE)
public class ApiExceptionHandler {

  private static final Logger log = LoggerFactory.getLogger(ApiExceptionHandler.class);

  @ExceptionHandler(NotFoundException.class)
  public ProblemDetail notFound(NotFoundException e) {
    return problem(HttpStatus.NOT_FOUND, "not-found", "Not found", e.getMessage());
  }

  @ExceptionHandler(ValidationException.class)
  public ProblemDetail invalid(ValidationException e) {
    return problem(HttpStatus.BAD_REQUEST, "invalid-request", "Invalid request", e.getMessage());
  }

  @ExceptionHandler(NoResourceFoundException.class)
  public ProblemDetail noSuchRoute(NoResourceFoundException e) {
    return problem(HttpStatus.NOT_FOUND, "no-such-route", "Not found", "no route for this path");
  }

  /**
   * Two requests that pass the existence checks can still race to the same unique key, for example
   * two admins creating the same property. The loser gets a conflict, not a server error. A value
   * the column cannot store (SQLState class 22, such as an amount beyond {@code NUMERIC(12, 2)}) is
   * a problem with the request, not a conflict.
   */
  @ExceptionHandler(DataIntegrityViolationException.class)
  public ProblemDetail uniqueKeyRace(DataIntegrityViolationException e) {
    String sqlState = sqlState(e);
    log.warn(
        "write rejected by a database constraint: {} sqlState={}",
        e.getClass().getName(),
        sqlState);
    if (sqlState.startsWith("22")) {
      return problem(
          HttpStatus.BAD_REQUEST,
          "invalid-request",
          "Invalid request",
          "a value in the request, or an amount computed from it, is out of range");
    }
    return problem(
        HttpStatus.CONFLICT,
        "conflict",
        "Conflict",
        "the change conflicts with stored data; check the request and try again");
  }

  @ExceptionHandler(MissingServletRequestParameterException.class)
  public ProblemDetail missingParameter(MissingServletRequestParameterException e) {
    return problem(
        HttpStatus.BAD_REQUEST,
        "invalid-request",
        "Invalid request",
        "the parameter " + e.getParameterName() + " is required");
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

  @ExceptionHandler(HoldExpiredException.class)
  public ProblemDetail holdExpired(HoldExpiredException e) {
    return problem(HttpStatus.GONE, "hold-expired", "Hold expired", e.getMessage());
  }

  @ExceptionHandler(InsufficientAvailabilityException.class)
  public ProblemDetail insufficientAvailability(InsufficientAvailabilityException e) {
    return problem(
        HttpStatus.CONFLICT, "insufficient-availability", "Not enough rooms", e.getMessage());
  }

  @ExceptionHandler(ConflictException.class)
  public ProblemDetail conflict(ConflictException e) {
    return problem(HttpStatus.CONFLICT, "conflict", "Conflict", e.getMessage());
  }

  @ExceptionHandler(PaymentFailedException.class)
  public ProblemDetail paymentFailed(PaymentFailedException e) {
    log.warn("payment failed: {}", e.getClass().getName());
    return problem(
        HttpStatus.BAD_GATEWAY,
        "payment-failed",
        "Payment failed",
        "the payment was not processed");
  }

  @ExceptionHandler(ObjectOptimisticLockingFailureException.class)
  public ProblemDetail concurrentUpdate(ObjectOptimisticLockingFailureException e) {
    return problem(
        HttpStatus.CONFLICT,
        "concurrent-update",
        "Concurrent update",
        "the resource changed while the request was processed; reload and try again");
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
        "the body is not valid JSON");
  }

  /**
   * Anything without a handler above is a server error. Framework errors keep the status and
   * headers they carry; every other failure is logged in full and answered with a generic detail.
   */
  @ExceptionHandler(Exception.class)
  public ResponseEntity<Object> unexpected(Exception e) {
    if (e instanceof ErrorResponse error) {
      return ResponseEntity.status(error.getStatusCode())
          .headers(error.getHeaders())
          .body(error.getBody());
    }
    log.error("unexpected failure: {}", shape(e));
    return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
        .body(
            problem(
                HttpStatus.INTERNAL_SERVER_ERROR,
                "internal-error",
                "Internal error",
                "an unexpected error occurred; the server log has the details"));
  }

  /**
   * A row lock that could not be had in time, or a deadlock: the same change can be sent again. The
   * caller is told to wait a second first.
   */
  @ExceptionHandler({
    PessimisticLockingFailureException.class,
    LockTimeoutException.class,
    PessimisticLockException.class
  })
  public ResponseEntity<ProblemDetail> lockBusy(RuntimeException e) {
    log.warn("row lock not acquired: {}", e.getClass().getName());
    return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE)
        .header(HttpHeaders.RETRY_AFTER, "1")
        .body(
            problem(
                HttpStatus.SERVICE_UNAVAILABLE,
                "busy",
                "Busy",
                "the record is being changed by another request; retry in a moment"));
  }

  /** The SQLState of the first SQL error in the chain, or "none"; never the database message. */
  static String sqlState(Throwable failure) {
    for (Throwable t = failure; t != null; t = t.getCause()) {
      if (t instanceof java.sql.SQLException sql && sql.getSQLState() != null) {
        return sql.getSQLState();
      }
    }
    return "none";
  }

  /**
   * The exception classes and the code location of their first frames, with no messages: a message
   * can carry a reservation reference, a hold id or database detail with guest values.
   */
  static String shape(Throwable failure) {
    var shape = new StringBuilder();
    int depth = 0;
    for (Throwable t = failure; t != null && depth < 5; t = t.getCause(), depth++) {
      if (depth > 0) {
        shape.append(" caused by ");
      }
      shape.append(t.getClass().getName());
      StackTraceElement[] frames = t.getStackTrace();
      if (frames.length > 0) {
        shape.append(" at ").append(frames[0]);
      }
    }
    return shape.toString();
  }

  private static ProblemDetail problem(
      HttpStatus status, String slug, String title, String detail) {
    ProblemDetail problem = ProblemDetail.forStatusAndDetail(status, detail);
    problem.setType(URI.create("urn:innkeep:problem:" + slug));
    problem.setTitle(title);
    return problem;
  }
}
