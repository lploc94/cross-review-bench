package com.papertrail.workflow.api.dto;

/** Small response bodies. Read models are returned as the service builds them. */
public final class Responses {

  private Responses() {}

  public record IdResponse(long id) {}

  public record CountResponse(long count) {}

  public record TokenResponse(String token) {}

  public record JobRunResponse(int escalated, int sent, int failed) {}
}
