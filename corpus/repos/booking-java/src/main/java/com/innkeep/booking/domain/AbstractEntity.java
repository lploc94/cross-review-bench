package com.innkeep.booking.domain;

import java.io.Serializable;
import org.hibernate.Hibernate;

/**
 * Base for JPA entities. Identity is the database id: two entities are equal when they are the same
 * class (proxies included) and carry the same non-null id. Before an entity is saved its id is
 * null, so it equals nothing but itself. The hash code is constant per class, which stays stable
 * while the id is assigned and works across proxies.
 */
public abstract class AbstractEntity<I extends Serializable> {

  public abstract I getId();

  @Override
  public final boolean equals(Object other) {
    if (this == other) {
      return true;
    }
    if (!(other instanceof AbstractEntity<?> that)) {
      return false;
    }
    I id = getId();
    return id != null
        && Hibernate.getClass(this) == Hibernate.getClass(that)
        && id.equals(that.getId());
  }

  @Override
  public final int hashCode() {
    return Hibernate.getClass(this).hashCode();
  }
}
