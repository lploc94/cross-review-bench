package com.innkeep.booking.persistence;

import com.innkeep.booking.domain.Property;
import java.util.Optional;
import org.springframework.data.jpa.repository.JpaRepository;

public interface PropertyRepository extends JpaRepository<Property, Long> {

  Optional<Property> findByCode(String code);
}
