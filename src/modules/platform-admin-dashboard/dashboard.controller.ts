import type { NextFunction, Response } from "express";
import { platformAdminDashboardService } from "./dashboard.service.js";
import type { AdminAuthenticatedRequest } from "../../middlewares/authenticate-admin-session.js";

export class PlatformAdminDashboardController {
  async getOverview(
    _req: AdminAuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const data = await platformAdminDashboardService.getOverviewMetrics();
      res.status(200).json({
        success: true,
        data,
      });
    } catch (err) {
      next(err);
    }
  }

  async getRevenue(
    _req: AdminAuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const data = await platformAdminDashboardService.getRevenueMetrics();
      res.status(200).json({
        success: true,
        data,
      });
    } catch (err) {
      next(err);
    }
  }

  async getAnalytics(
    _req: AdminAuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const data = await platformAdminDashboardService.getAnalyticsMetrics();
      res.status(200).json({
        success: true,
        data,
      });
    } catch (err) {
      next(err);
    }
  }

  async exportAnalyticsCsv(
    _req: AdminAuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const csvData = await platformAdminDashboardService.generateAnalyticsCsv();
      const filename = `platform-analytics-${new Date().toISOString().slice(0, 10)}.csv`;
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.status(200).send(csvData);
    } catch (err) {
      next(err);
    }
  }

  async listWorkspaces(
    req: AdminAuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const { page, limit, status, search } = req.query;
      const data = await platformAdminDashboardService.listWorkspaces({
        page: page ? parseInt(String(page), 10) : 1,
        limit: limit ? parseInt(String(limit), 10) : 10,
        status: status ? String(status) : undefined,
        search: search ? String(search) : undefined,
      });

      res.status(200).json({
        success: true,
        data,
      });
    } catch (err) {
      next(err);
    }
  }

  async listUsers(
    req: AdminAuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const { page, limit, role, platformRole, isActive, search } = req.query;
      const data = await platformAdminDashboardService.listUsers({
        page: page ? parseInt(String(page), 10) : 1,
        limit: limit ? parseInt(String(limit), 10) : 10,
        role: role ? String(role) : undefined,
        platformRole: platformRole ? String(platformRole) : undefined,
        isActive: isActive !== undefined ? isActive === "true" : undefined,
        search: search ? String(search) : undefined,
      });

      res.status(200).json({
        success: true,
        data,
      });
    } catch (err) {
      next(err);
    }
  }

  async listSubscriptions(
    req: AdminAuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const { page, limit, plan, status, search } = req.query;
      const data = await platformAdminDashboardService.listSubscriptions({
        page: page ? parseInt(String(page), 10) : 1,
        limit: limit ? parseInt(String(limit), 10) : 10,
        plan: plan ? String(plan) : undefined,
        status: status ? String(status) : undefined,
        search: search ? String(search) : undefined,
      });

      res.status(200).json({
        success: true,
        data,
      });
    } catch (err) {
      next(err);
    }
  }

  async listPayments(
    req: AdminAuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const { page, limit, status, method, search } = req.query;
      const data = await platformAdminDashboardService.listPayments({
        page: page ? parseInt(String(page), 10) : 1,
        limit: limit ? parseInt(String(limit), 10) : 10,
        status: status ? String(status) : undefined,
        method: method ? String(method) : undefined,
        search: search ? String(search) : undefined,
      });

      res.status(200).json({
        success: true,
        data,
      });
    } catch (err) {
      next(err);
    }
  }

  async listInvoices(
    req: AdminAuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const { page, limit, search } = req.query;
      const data = await platformAdminDashboardService.listInvoices({
        page: page ? parseInt(String(page), 10) : 1,
        limit: limit ? parseInt(String(limit), 10) : 10,
        search: search ? String(search) : undefined,
      });

      res.status(200).json({
        success: true,
        data,
      });
    } catch (err) {
      next(err);
    }
  }

  async listAuditLogs(
    req: AdminAuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const { page, limit, eventType, search } = req.query;
      const data = await platformAdminDashboardService.listAuditLogs({
        page: page ? parseInt(String(page), 10) : 1,
        limit: limit ? parseInt(String(limit), 10) : 10,
        eventType: eventType ? String(eventType) : undefined,
        search: search ? String(search) : undefined,
      });

      res.status(200).json({
        success: true,
        data,
      });
    } catch (err) {
      next(err);
    }
  }
}

export const platformAdminDashboardController = new PlatformAdminDashboardController();
