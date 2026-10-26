package com.papertrail.workflow.domain;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.JoinColumn;
import jakarta.persistence.JoinTable;
import jakarta.persistence.ManyToMany;
import jakarta.persistence.Table;
import java.util.HashSet;
import java.util.Set;

/** A named set of users that a workflow step can assign as a whole, such as "finance". */
@Entity
@Table(name = "user_group")
public class UserGroup extends AbstractEntity<Long> {

  @Id
  @GeneratedValue(strategy = GenerationType.IDENTITY)
  private Long id;

  @Column(nullable = false, unique = true, length = 80)
  private String name;

  @ManyToMany
  @JoinTable(
      name = "group_member",
      joinColumns = @JoinColumn(name = "group_id"),
      inverseJoinColumns = @JoinColumn(name = "user_id"))
  private Set<AppUser> members = new HashSet<>();

  protected UserGroup() {}

  public UserGroup(String name) {
    this.name = AppUser.requireText(name, "name", 80);
  }

  @Override
  public Long getId() {
    return id;
  }

  public String getName() {
    return name;
  }

  public Set<AppUser> getMembers() {
    return Set.copyOf(members);
  }

  public boolean hasMember(AppUser user) {
    return members.contains(user);
  }

  public void addMember(AppUser user) {
    if (!user.isActive()) {
      throw new ValidationException("an inactive user cannot join a group");
    }
    members.add(user);
  }

  public void removeMember(AppUser user) {
    members.remove(user);
  }

  public void rename(String newName) {
    this.name = AppUser.requireText(newName, "name", 80);
  }
}
