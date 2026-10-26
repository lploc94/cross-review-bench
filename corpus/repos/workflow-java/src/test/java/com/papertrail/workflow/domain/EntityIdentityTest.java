package com.papertrail.workflow.domain;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.springframework.test.util.ReflectionTestUtils;

class EntityIdentityTest {

  private static AppUser savedUser(long id) {
    AppUser user = new AppUser("Mira Okafor", "mira@example.com", false);
    ReflectionTestUtils.setField(user, "id", id);
    return user;
  }

  @Test
  void unsavedEntitiesEqualNothingButThemselves() {
    AppUser first = new AppUser("Mira Okafor", "mira@example.com", false);
    AppUser second = new AppUser("Mira Okafor", "mira@example.com", false);

    assertThat(first).isEqualTo(first).isNotEqualTo(second);
  }

  @Test
  void savedEntitiesOfOneClassAreEqualByIdentifier() {
    assertThat(savedUser(7)).isEqualTo(savedUser(7)).isNotEqualTo(savedUser(8));
  }

  @Test
  void entitiesOfDifferentClassesAreNeverEqual() {
    UserGroup group = new UserGroup("finance");
    ReflectionTestUtils.setField(group, "id", 7L);

    assertThat(savedUser(7)).isNotEqualTo(group);
  }

  @Test
  void theHashCodeDoesNotChangeWhenTheIdentifierIsAssigned() {
    AppUser user = new AppUser("Mira Okafor", "mira@example.com", false);
    int before = user.hashCode();

    ReflectionTestUtils.setField(user, "id", 9L);

    assertThat(user.hashCode()).isEqualTo(before);
  }

  @Test
  void emailsAreNormalisedAndMustLookLikeAnAddress() {
    assertThat(new AppUser("Mira", "  Mira@Example.COM ", false).getEmail())
        .isEqualTo("mira@example.com");
    org.assertj.core.api.Assertions.assertThatThrownBy(
            () -> new AppUser("Mira", "mira.example.com", false))
        .isInstanceOf(ValidationException.class);
  }
}
