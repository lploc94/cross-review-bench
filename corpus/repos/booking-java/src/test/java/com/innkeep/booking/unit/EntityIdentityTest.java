package com.innkeep.booking.unit;

import static org.assertj.core.api.Assertions.assertThat;

import com.innkeep.booking.domain.GuestDetails;
import com.innkeep.booking.domain.Property;
import com.innkeep.booking.domain.RoomType;
import com.innkeep.booking.support.Fixtures;
import org.junit.jupiter.api.Test;
import org.springframework.test.util.ReflectionTestUtils;

class EntityIdentityTest {

  @Test
  void unsavedEntitiesEqualOnlyThemselves() {
    Property first = Fixtures.property("Europe/Lisbon", 0, 0);
    Property second = Fixtures.property("Europe/Lisbon", 0, 0);

    assertThat(first).isEqualTo(first).isNotEqualTo(second);
  }

  @Test
  void savedEntitiesEqualWhenClassAndIdMatch() {
    Property first = Fixtures.property("Europe/Lisbon", 0, 0);
    Property second = Fixtures.property("Europe/Lisbon", 0, 0);
    ReflectionTestUtils.setField(first, "id", 7L);
    ReflectionTestUtils.setField(second, "id", 7L);

    assertThat(first).isEqualTo(second);
    assertThat(first.hashCode()).isEqualTo(second.hashCode());
  }

  @Test
  void entitiesOfDifferentClassesWithTheSameIdAreDifferent() {
    Property property = Fixtures.property("Europe/Lisbon", 0, 0);
    RoomType room = Fixtures.roomType(property, 2, "100.00");
    ReflectionTestUtils.setField(property, "id", 3L);
    ReflectionTestUtils.setField(room, "id", 3L);

    assertThat(property).isNotEqualTo(room);
  }

  @Test
  void hashCodeDoesNotChangeWhenTheIdIsAssigned() {
    Property property = Fixtures.property("Europe/Lisbon", 0, 0);
    int before = property.hashCode();

    ReflectionTestUtils.setField(property, "id", 11L);

    assertThat(property.hashCode()).isEqualTo(before);
  }

  @Test
  void guestEmailIsNormalisedAndContactDetailsStayOutOfToString() {
    var guest = new GuestDetails("  Mara Quill ", " GUEST@Example.COM ", "  ");

    assertThat(guest.getName()).isEqualTo("Mara Quill");
    assertThat(guest.getEmail()).isEqualTo("guest@example.com");
    assertThat(guest.getPhone()).isNull();
    assertThat(guest.toString()).doesNotContain("guest@example.com");
  }
}
