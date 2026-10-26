package com.innkeep.booking.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.innkeep.booking.domain.Property;
import com.innkeep.booking.domain.RoomType;
import com.innkeep.booking.support.IntegrationTestBase;
import com.jayway.jsonpath.JsonPath;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;

class AdminCatalogApiTest extends IntegrationTestBase {

  private static final String PROPERTIES = "/api/v1/admin/properties";
  private static final String NEW_PROPERTY =
      """
      {"code":"seaside-house","name":"Seaside House","timeZone":"Europe/Lisbon",
       "checkInTime":"15:00","checkOutTime":"11:00","currency":"EUR",
       "policy":{"fullRefundDays":7,"partialRefundPercent":50,"weekendSurchargePercent":10,
                 "losMinNights":3,"losDiscountPercent":5}}""";

  private Property property;
  private RoomType doubleRoom;

  @BeforeEach
  void setUp() {
    property = data.harbourHouse();
    doubleRoom = data.roomType(property, "double", 2, "100.00");
  }

  @Test
  void aCurrencyWithThreeMinorUnitsIsRefusedBecauseMoneyIsStoredToCents() throws Exception {
    mvc.perform(
            post(PROPERTIES)
                .header("Authorization", ADMIN_AUTH)
                .contentType(MediaType.APPLICATION_JSON)
                .content(NEW_PROPERTY.replace("\"EUR\"", "\"KWD\"")))
        .andExpect(status().isBadRequest());

    assertThat(
            jdbc.queryForObject(
                "select count(*) from property where code = 'seaside-house'", Integer.class))
        .isZero();
  }

  @Test
  void aNewPropertyIsCreatedWithItsLocation() throws Exception {
    mvc.perform(
            post(PROPERTIES)
                .header("Authorization", ADMIN_AUTH)
                .contentType(MediaType.APPLICATION_JSON)
                .content(NEW_PROPERTY))
        .andExpect(status().isCreated())
        .andExpect(header().string("Location", "/api/v1/properties/seaside-house"))
        .andExpect(jsonPath("$.timeZone").value("Europe/Lisbon"))
        .andExpect(jsonPath("$.currency").value("EUR"));

    mvc.perform(
            post(PROPERTIES)
                .header("Authorization", ADMIN_AUTH)
                .contentType(MediaType.APPLICATION_JSON)
                .content(NEW_PROPERTY))
        .andExpect(status().isConflict())
        .andExpect(jsonPath("$.type").value("urn:innkeep:problem:conflict"));
  }

  @Test
  void aPolicyOutsideItsRangeIsRefused() throws Exception {
    String bad = NEW_PROPERTY.replace("\"fullRefundDays\":7", "\"fullRefundDays\":400");
    mvc.perform(
            post(PROPERTIES)
                .header("Authorization", ADMIN_AUTH)
                .contentType(MediaType.APPLICATION_JSON)
                .content(bad))
        .andExpect(status().isBadRequest())
        .andExpect(jsonPath("$.type").value("urn:innkeep:problem:invalid-request"));
  }

  @Test
  void anUnknownTimeZoneIsRefused() throws Exception {
    String bad = NEW_PROPERTY.replace("Europe/Lisbon", "Mars/Olympus");
    mvc.perform(
            post(PROPERTIES)
                .header("Authorization", ADMIN_AUTH)
                .contentType(MediaType.APPLICATION_JSON)
                .content(bad))
        .andExpect(status().isBadRequest());
  }

  @Test
  void detailsAndPolicyCanBeChangedAndAreReadBack() throws Exception {
    mvc.perform(
            put(PROPERTIES + "/harbour-house")
                .header("Authorization", ADMIN_AUTH)
                .contentType(MediaType.APPLICATION_JSON)
                .content(
                    "{\"name\":\"Harbour House Annex\",\"timeZone\":\"Europe/Lisbon\","
                        + "\"checkInTime\":\"16:00\",\"checkOutTime\":\"11:00\"}"))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.name").value("Harbour House Annex"));

    mvc.perform(
            put(PROPERTIES + "/harbour-house/policy")
                .header("Authorization", ADMIN_AUTH)
                .contentType(MediaType.APPLICATION_JSON)
                .content(
                    "{\"fullRefundDays\":14,\"partialRefundPercent\":25,"
                        + "\"weekendSurchargePercent\":15,\"losMinNights\":2,"
                        + "\"losDiscountPercent\":8}"))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.fullRefundDays").value(14))
        .andExpect(jsonPath("$.weekendSurchargePercent").value(15));

    mvc.perform(get("/api/v1/properties/harbour-house"))
        .andExpect(jsonPath("$.name").value("Harbour House Annex"))
        .andExpect(jsonPath("$.losDiscountPercent").value(8));
  }

  @Test
  void aRoomTypeCanBeAddedAndRepriced() throws Exception {
    String suite =
        "{\"code\":\"suite\",\"name\":\"Suite\",\"capacity\":3,"
            + "\"baseNightlyRate\":180.00,\"extraGuestFee\":20.00}";
    mvc.perform(
            post(PROPERTIES + "/harbour-house/room-types")
                .header("Authorization", ADMIN_AUTH)
                .contentType(MediaType.APPLICATION_JSON)
                .content(suite))
        .andExpect(status().isCreated())
        .andExpect(
            header().string("Location", "/api/v1/properties/harbour-house/room-types/suite"));

    mvc.perform(
            post(PROPERTIES + "/harbour-house/room-types")
                .header("Authorization", ADMIN_AUTH)
                .contentType(MediaType.APPLICATION_JSON)
                .content(suite))
        .andExpect(status().isConflict());

    mvc.perform(
            put(PROPERTIES + "/harbour-house/room-types/suite/rates")
                .header("Authorization", ADMIN_AUTH)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"baseNightlyRate\":190.50,\"extraGuestFee\":20.00}"))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.baseNightlyRate").value(190.50));

    mvc.perform(
            put(PROPERTIES + "/harbour-house/room-types/suite/rates")
                .header("Authorization", ADMIN_AUTH)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"baseNightlyRate\":-1,\"extraGuestFee\":20.00}"))
        .andExpect(status().isBadRequest());

    mvc.perform(get("/api/v1/properties/harbour-house/room-types/suite"))
        .andExpect(jsonPath("$.capacity").value(3));
  }

  @Test
  void seasonalRatesOverlapOnlyAcrossDifferentPriorities() throws Exception {
    String path = PROPERTIES + "/harbour-house/room-types/double/seasonal-rates";
    String summer =
        "{\"startDate\":\"2027-06-01\",\"endDate\":\"2027-06-30\","
            + "\"nightlyRate\":130.00,\"priority\":1}";
    mvc.perform(
            post(path)
                .header("Authorization", ADMIN_AUTH)
                .contentType(MediaType.APPLICATION_JSON)
                .content(summer))
        .andExpect(status().isCreated());

    mvc.perform(
            post(path)
                .header("Authorization", ADMIN_AUTH)
                .contentType(MediaType.APPLICATION_JSON)
                .content(summer.replace("06-30", "06-15").replace("06-01", "06-10")))
        .andExpect(status().isConflict());

    mvc.perform(
            post(path)
                .header("Authorization", ADMIN_AUTH)
                .contentType(MediaType.APPLICATION_JSON)
                .content(summer.replace("\"priority\":1", "\"priority\":2")))
        .andExpect(status().isCreated());

    String listed =
        mvc.perform(get(path).header("Authorization", ADMIN_AUTH))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.length()").value(2))
            .andExpect(jsonPath("$[0].priority").value(1))
            .andReturn()
            .getResponse()
            .getContentAsString();
    long firstId = ((Number) JsonPath.read(listed, "$[0].id")).longValue();

    mvc.perform(delete(path + "/" + firstId).header("Authorization", ADMIN_AUTH))
        .andExpect(status().isNoContent());
    mvc.perform(delete(path + "/" + firstId).header("Authorization", ADMIN_AUTH))
        .andExpect(status().isNotFound());
  }

  @Test
  void inventoryCanBeSetForARangeAndReadPerNight() throws Exception {
    String inventory = "/api/v1/admin/properties/harbour-house/room-types/double/inventory";
    mvc.perform(
            put(inventory + "/range")
                .header("Authorization", ADMIN_AUTH)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"from\":\"2027-06-01\",\"to\":\"2027-06-04\",\"total\":3}"))
        .andExpect(status().isNoContent());

    mvc.perform(
            get(inventory)
                .header("Authorization", ADMIN_AUTH)
                .param("from", "2027-06-01")
                .param("to", "2027-06-04"))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.length()").value(3))
        .andExpect(jsonPath("$[0].total").value(3))
        .andExpect(jsonPath("$[0].available").value(3))
        .andExpect(jsonPath("$[2].night").value("2027-06-03"));

    mvc.perform(
            get(inventory)
                .header("Authorization", ADMIN_AUTH)
                .param("from", "2027-06-04")
                .param("to", "2027-06-01"))
        .andExpect(status().isBadRequest());
  }

  @Test
  void theCatalogueWritesRequireTheAdminToken() throws Exception {
    mvc.perform(post(PROPERTIES).contentType(MediaType.APPLICATION_JSON).content(NEW_PROPERTY))
        .andExpect(status().isUnauthorized());
    mvc.perform(get(PROPERTIES + "/harbour-house/room-types/double/seasonal-rates"))
        .andExpect(status().isUnauthorized());
  }
}
