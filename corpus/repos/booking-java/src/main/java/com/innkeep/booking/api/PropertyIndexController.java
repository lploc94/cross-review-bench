package com.innkeep.booking.api;

import com.innkeep.booking.api.dto.PropertyResponse;
import com.innkeep.booking.service.CatalogService;
import java.util.List;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/properties")
public class PropertyIndexController {

  private final CatalogService catalog;

  public PropertyIndexController(CatalogService catalog) {
    this.catalog = catalog;
  }

  @GetMapping
  public List<PropertyResponse> properties() {
    return catalog.properties().stream().map(PropertyResponse::from).toList();
  }
}
