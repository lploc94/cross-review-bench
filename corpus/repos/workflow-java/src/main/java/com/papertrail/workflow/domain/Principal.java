package com.papertrail.workflow.domain;

/** The authenticated user a request acts for. Admins see every document. */
public record Principal(long userId, boolean admin) {}
