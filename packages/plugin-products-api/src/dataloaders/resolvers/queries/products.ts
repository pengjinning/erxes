import {
  checkPermission,
  requireLogin
} from '@erxes/api-utils/src/permissions';
import { afterQueryWrapper, paginate } from '@erxes/api-utils/src';
import { PRODUCT_STATUSES } from '../../../models/definitions/products';
import { escapeRegExp } from '@erxes/api-utils/src/core';
import { IContext } from '../../../connectionResolver';
import messageBroker, { sendTagsMessage } from '../../../messageBroker';
import { Builder, countBySegment, countByTag, IListArgs } from '../../../utils';

interface IQueryParams {
  ids?: string[];
  excludeIds?: boolean;
  type?: string;
  categoryId?: string;
  searchValue?: string;
  tag: string;
  page?: number;
  perPage?: number;
  sortField?: string;
  sortDirection?: number;
  pipelineId?: string;
  boardId?: string;
  segment?: string;
  segmentData?: string;
  groupCatDiffVals: boolean;
}

const generateFilter = async (
  subdomain,
  models,
  commonQuerySelector,
  params
) => {
  const {
    type,
    categoryId,
    searchValue,
    tag,
    ids,
    excludeIds,
    pipelineId,
    boardId,
    segment,
    segmentData,
    sortField,
    sortDirection,
    ...pagintationArgs
  } = params;
  const filter: any = commonQuerySelector;

  filter.status = { $ne: PRODUCT_STATUSES.DELETED };

  if (type) {
    filter.type = type;
  }

  if (categoryId) {
    const category = await models.ProductCategories.getProductCatogery({
      _id: categoryId,
      status: { $in: [null, 'active'] }
    });

    const product_category_ids = await models.ProductCategories.find(
      { order: { $regex: new RegExp(`^${category.order}`) } },
      { _id: 1 }
    );
    filter.categoryId = { $in: product_category_ids };
  } else {
    const notActiveCategories = await models.ProductCategories.find({
      status: { $nin: [null, 'active'] }
    });

    filter.categoryId = { $nin: notActiveCategories.map(e => e._id) };
  }

  if (ids && ids.length > 0) {
    filter._id = { [excludeIds ? '$nin' : '$in']: ids };
    if (!pagintationArgs.page && !pagintationArgs.perPage) {
      pagintationArgs.page = 1;
      pagintationArgs.perPage = 100;
    }
  }

  if (tag) {
    filter.tagIds = { $in: [tag] };
  }

  // search =========
  if (searchValue) {
    const regex = new RegExp(`.*${escapeRegExp(searchValue)}.*`, 'i');
    const codeRegex = new RegExp(
      `^${searchValue
        .replace(/\./g, '\\.')
        .replace(/\*/g, '.')
        .replace(/_/g, '.')
        .replace(/  /g, '.')}.*`,
      'igu'
    );

    filter.$or = [
      {
        $or: [{ code: { $in: [regex] } }, { code: { $in: [codeRegex] } }]
      },
      { name: { $in: [regex] } },
      { barcodes: { $in: [searchValue] } }
    ];
  }

  if (segment || segmentData) {
    const qb = new Builder(models, subdomain, { segment, segmentData }, {});

    await qb.buildAllQueries();

    const { list } = await qb.runQueries();

    filter._id = { $in: list.map(l => l._id) };
  }

  return filter;
};

const productQueries = {
  /**
   * Products list
   */
  async products(
    _root,
    params: IQueryParams,
    { commonQuerySelector, models, subdomain, user }: IContext
  ) {
    const filter = await generateFilter(
      subdomain,
      models,
      commonQuerySelector,
      params
    );

    const { sortField, sortDirection, ...pagintationArgs } = params;

    let sort: any = { code: 1 };
    if (sortField) {
      sort = { [sortField]: sortDirection || 1 };
    }

    return afterQueryWrapper(
      subdomain,
      'products',
      params,
      await paginate(
        models.Products.find(filter)
          .sort(sort)
          .lean(),
        pagintationArgs
      ),
      messageBroker(),
      user
    );
  },

  async productsTotalCount(
    _root,
    params: IQueryParams,
    { commonQuerySelector, models, subdomain }: IContext
  ) {
    const filter = await generateFilter(
      subdomain,
      models,
      commonQuerySelector,
      params
    );

    return models.Products.find(filter).count();
  },

  /**
   * Group product counts by segment or tag
   */
  async productsGroupCounts(
    _root,
    params,
    { commonQuerySelector, commonQuerySelectorElk, models, subdomain }: IContext
  ) {
    const counts = {
      bySegment: {},
      byTag: {}
    };

    const { only } = params;

    const qb = new Builder(models, subdomain, params, {
      commonQuerySelector,
      commonQuerySelectorElk
    });

    switch (only) {
      case 'byTag':
        counts.byTag = await countByTag(subdomain, 'products:product', qb);
        break;

      case 'bySegment':
        counts.bySegment = await countBySegment(
          subdomain,
          'products:product',
          qb
        );
        break;
    }

    return counts;
  },

  productCategories(
    _root,
    {
      parentId,
      searchValue,
      status,
      meta
    }: { parentId: string; searchValue: string; status: string; meta: string },
    { commonQuerySelector, models }: IContext
  ) {
    const filter: any = commonQuerySelector;

    filter.status = { $nin: ['disabled', 'archived'] };

    if (status && status !== 'active') {
      filter.status = status;
    }

    if (parentId) {
      filter.parentId = parentId;
    }

    if (searchValue) {
      filter.name = new RegExp(`.*${searchValue}.*`, 'i');
    }

    if (meta) {
      if (!isNaN(parseFloat(meta))) {
        filter.meta = { $lte: Number(meta) };
      } else {
        filter.meta = meta;
      }
    }

    return models.ProductCategories.find(filter)
      .sort({ order: 1 })
      .lean();
  },

  productCategoriesTotalCount(_root, _params, { models }: IContext) {
    return models.ProductCategories.find().countDocuments();
  },

  productDetail(_root, { _id }: { _id: string }, { models }: IContext) {
    return models.Products.findOne({ _id }).lean();
  },

  productCategoryDetail(_root, { _id }: { _id: string }, { models }: IContext) {
    return models.ProductCategories.findOne({ _id }).lean();
  },

  async productCountByTags(_root, _params, { models, subdomain }: IContext) {
    const counts = {};

    // Count products by tag =========
    const tags = await sendTagsMessage({
      subdomain,
      action: 'find',
      data: {
        type: 'products:product'
      },
      isRPC: true,
      defaultValue: []
    });

    for (const tag of tags) {
      counts[tag._id] = await models.Products.find({
        tagIds: tag._id,
        status: { $ne: PRODUCT_STATUSES.DELETED }
      }).countDocuments();
    }

    return counts;
  }
};

requireLogin(productQueries, 'productsTotalCount');
checkPermission(productQueries, 'products', 'showProducts', []);
checkPermission(productQueries, 'productCategories', 'showProducts', []);
checkPermission(productQueries, 'productCountByTags', 'showProducts', []);

export default productQueries;
