package com.papertrail.workflow.api;

import com.papertrail.workflow.service.DefinitionService;
import com.papertrail.workflow.service.Views.DefinitionView;
import java.util.List;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** Read access to definitions for signed-in users. Creating and publishing is admin-only. */
@RestController
@RequestMapping("/api/v1/definitions")
public class DefinitionController {

  private final DefinitionService definitions;

  public DefinitionController(DefinitionService definitions) {
    this.definitions = definitions;
  }

  @GetMapping
  public List<DefinitionView> published(@RequestParam(required = false) String name) {
    return definitions.listPublished(name);
  }

  @GetMapping("/{id}")
  public DefinitionView one(@PathVariable long id) {
    return definitions.viewPublished(id);
  }
}
