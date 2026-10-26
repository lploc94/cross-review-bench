package com.innkeep.booking.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.innkeep.booking.domain.DisplayRate;
import com.innkeep.booking.domain.Property;
import com.innkeep.booking.domain.RoomType;
import com.innkeep.booking.support.IntegrationTestBase;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.Currency;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;

/**
 * Converted amounts that fall exactly halfway between two minor units round to the even one, in the
 * display currency's own minor units. The test context sets EUR→USD 1.085 and EUR→JPY 162.
 */
class DisplayAmountRoundingTest extends IntegrationTestBase {

  private static final Currency EUR = Currency.getInstance("EUR");

  private static BigDecimal convert(String to, String rate, String amount) {
    return new DisplayRate(EUR, Currency.getInstance(to), new BigDecimal(rate))
        .convert(new BigDecimal(amount));
  }

  @Test
  void halfwayAmountsRoundToEvenInTheDisplayCurrencysMinorUnits() {
    // 1.00 × 1.085 = 1.085 and 101.00 × 1.085 = 109.585: the even neighbour is below
    assertThat(convert("USD", "1.085", "1.00")).isEqualTo(new BigDecimal("1.08"));
    assertThat(convert("USD", "1.085", "101.00")).isEqualTo(new BigDecimal("109.58"));
    // 3.00 × 1.085 = 3.255: the even neighbour is above
    assertThat(convert("USD", "1.085", "3.00")).isEqualTo(new BigDecimal("3.26"));
    // yen has no minor units: 100.25 × 162 = 16240.5 and 100.75 × 162 = 16321.5
    assertThat(convert("JPY", "162", "100.25")).isEqualTo(new BigDecimal("16240"));
    assertThat(convert("JPY", "162", "100.75")).isEqualTo(new BigDecimal("16322"));
  }

  @Test
  void aQuoteShowsHalfwayAmountsRoundedToEven() throws Exception {
    Property property = data.harbourHouse();
    RoomType room = data.roomType(property, "double", 2, "101.00");
    data.rooms(property, room, LocalDate.parse("2027-06-08"), LocalDate.parse("2027-06-09"), 1);

    // a Tuesday night: no weekend surcharge, total 101.00
    mvc.perform(
            post("/api/v1/properties/harbour-house/quotes")
                .param("display", "USD")
                .contentType(MediaType.APPLICATION_JSON)
                .content(
                    "{\"roomType\":\"double\",\"checkIn\":\"2027-06-08\","
                        + "\"checkOut\":\"2027-06-09\",\"rooms\":1,\"guests\":2}"))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.total").value(101.00))
        .andExpect(jsonPath("$.display.total").value(109.58))
        .andExpect(jsonPath("$.display.lines[0].amount").value(109.58));
  }
}
