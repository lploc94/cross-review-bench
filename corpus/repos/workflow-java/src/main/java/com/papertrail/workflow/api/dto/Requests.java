package com.papertrail.workflow.api.dto;

import com.papertrail.workflow.domain.Decision;
import com.papertrail.workflow.domain.PermissionLevel;
import com.papertrail.workflow.domain.StepKind;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import java.util.List;

/** Request bodies. Bean validation covers shape and range; the domain covers the rules. */
public final class Requests {

  private Requests() {}

  public record CreateUserRequest(
      @NotBlank @Size(max = 120) String displayName,
      @NotBlank @Email @Size(max = 254) String email,
      boolean admin) {}

  public record CreateGroupRequest(@NotBlank @Size(max = 80) String name) {}

  public record CreateStepRequest(
      @Min(1) @Max(100) int order,
      @NotNull StepKind kind,
      Long assigneeId,
      Long groupId,
      @Min(0) @Max(1000) int quorum,
      @Min(1) @Max(43_200) int slaMinutes) {}

  public record CreateDefinitionRequest(
      @NotBlank @Size(max = 80) String name, @NotEmpty @Valid List<CreateStepRequest> steps) {}

  public record CreateDocumentRequest(
      @NotBlank @Size(max = 200) String title,
      @NotBlank @Size(max = 10_000) String body,
      @NotBlank @Size(max = 80) String definitionName) {}

  public record UpdateDocumentRequest(
      @NotBlank @Size(max = 200) String title, @NotBlank @Size(max = 10_000) String body) {}

  public record DecisionRequest(@NotNull Decision decision, @Size(max = 1000) String comment) {}

  public record GrantPermissionRequest(@NotNull PermissionLevel level) {}

  public record UpdateUserRequest(
      @Size(max = 120) String displayName, @Size(max = 254) String email, Boolean active) {}
}
