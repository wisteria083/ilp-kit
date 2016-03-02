"use strict"

module.exports = PaymentsControllerFactory

const _ = require('lodash')
const request = require('five-bells-shared/utils/request')
const passport = require('koa-passport')
const Auth = require('../lib/auth')
const Log = require('../lib/log')
const Ledger = require('../lib/ledger')
const Config = require('../lib/config')
const utils = require('../lib/utils')
const PaymentFactory = require('../models/payment')
const InvalidLedgerAccountError = require('../errors/invalid-ledger-account-error')
const LedgerInsufficientFundsError = require('../errors/ledger-insufficient-funds-error')
const NoPathsError = require('../errors/no-paths-error')

PaymentsControllerFactory.constitute = [Auth, PaymentFactory, Log, Ledger, Config]
function PaymentsControllerFactory (Auth, Payment, log, ledger, config) {
  log = log('payments')

  return class PaymentsController {
    static init (router) {
      router.get('/payments', Auth.isAuth, this.getHistory)
      //router.get('/payments/:id', Auth.isAuth, this.getResource)
      router.put('/payments/:id', Auth.isAuth, Payment.createBodyParser(), this.putResource)
      router.post('/payments/findPath', Auth.isAuth, this.findPath)
    }

    static * getHistory () {
      // TODO pagination
      const payments = yield Payment.getUserPayments(this.req.user)

      this.body = _.map(payments, (payment) => {
        return payment.getDataExternal()
      })
    }

    static * getResource () {
      let id = this.params.id
      request.validateUriParameter('id', id, 'Uuid')
      id = id.toLowerCase()

      const item = yield Payment.getPayment(id)

      if (!item) {
        this.status = 404
        return
      }

      this.body = item.getDataExternal()
    }

    // TODO handle payment creation. Shouldn't rely on notification seriv
    static * putResource () {
      const _this = this

      let id = _this.params.id
      request.validateUriParameter('id', id, 'Uuid')
      id = id.toLowerCase()
      let payment = this.body

      payment.id = id

      payment.source_user = this.req.user.id

      // TODO fill the destination_user
      const options = {
        sourceAmount: payment.source_amount,
        destinationAccount: payment.destination_account,
        destinationAmount: payment.destination_amount,
        path: payment.path,
        username: this.req.user.username,
        password: this.req.user.password
      }

      // Try doing the ledger transaction
      try {
        const transfer = yield ledger.transfer(options)

        // Interledger
        if (transfer.source_transfers) {
          payment.transfers = transfer.source_transfers[0].id
          payment.source_account = transfer.source_transfers[0].debits[0].account;
          payment.source_amount = transfer.source_transfers[0].debits[0].amount;
          payment.destination_account = transfer.destination_transfers[0].credits[0].account;
          payment.destination_amount = transfer.destination_transfers[0].credits[0].amount;
        }

        // Same ledger
        else {
          payment.transfers = transfer.id
          payment.source_account = transfer.debits[0].account;
          payment.source_amount = transfer.debits[0].amount;
          payment.destination_account = transfer.credits[0].account;
          payment.destination_amount = transfer.credits[0].amount;
        }

        log.debug('Ledger transfer payment ID ' + id)
      } catch (e) {
        let error = JSON.parse(e.response.error.text)

        if (error.id === 'UnprocessableEntityError') {
          throw new InvalidLedgerAccountError(error.message)
        } else if (error.id === 'InsufficientFundsError') {
          throw new LedgerInsufficientFundsError(error.message)
        } else {
          // TODO more meaningful error
          throw new Error()
        }
      }

      // Store the payment in db
      // Notification service creates the payment
      try {
        yield payment.create()
      } catch (e) {
        // TODO handle
      }

      // Get the payment with the associations
      // TODO get by transfer or paymentId
      payment = yield Payment.getPayment(payment.transfers)

      this.body = payment.getDataExternal()
    }

    // TODO handle account doesn't exist exception
    // TODO handle not supplied params
    static * findPath () {
      let destination = utils.parseDestination(this.body.destination, config.data.getIn(['ledger', 'uri']));

      if (destination.type === 'local') {
        let amount = this.body.source_amount || this.body.destination_amount

        this.body = {
          sourceAmount: amount,
          destinationAmount: amount
        }

        return
      }

      const options = {
        destinationAccount: destination.accountUri,
        sourceAmount: this.body.source_amount,
        destinationAmount: this.body.destination_amount,
        username: this.req.user.username
      }

      let path = yield ledger.findPath(options)

      if (!path) {
        throw new NoPathsError("No paths to specified destination found")
      }

      this.body = path
    }
  }
}
