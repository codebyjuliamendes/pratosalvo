'use strict';

/** Erros de regra de negócio; a camada HTTP converte em status e JSON. */
class DomainError extends Error {
  /** @param details campos extras públicos (ex.: { code: 'sold_out', available: 2 }) */
  constructor(message, details = {}) {
    super(message);
    this.name = new.target.name;
    this.details = details;
  }
}

/** Entrada inválida (400). */
class ValidationError extends DomainError {}
/** Recurso inexistente ou inacessível (404). */
class NotFoundError extends DomainError {}
/** Estado atual impede a operação (409). */
class ConflictError extends DomainError {}

module.exports = { DomainError, ValidationError, NotFoundError, ConflictError };
